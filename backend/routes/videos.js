const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const db = require('../config/database');
const authMiddleware = require('../middlewares/authMiddleware');
const SSHManager = require('../config/SSHManager');
const wowzaService = require('../config/WowzaStreamingService');

const router = express.Router();

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const tempDir = '/tmp/video-uploads';
      await fs.mkdir(tempDir, { recursive: true });
      cb(null, tempDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const sanitizedName = file.originalname
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/_{2,}/g, '_');
    cb(null, `${Date.now()}_${sanitizedName}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'video/mp4', 'video/avi', 'video/mov', 'video/wmv', 
      'video/flv', 'video/webm', 'video/mkv'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não suportado'), false);
    }
  }
});

router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const folderId = req.query.folder_id;
    if (!folderId) {
      return res.status(400).json({ error: 'folder_id é obrigatório' });
    }

    const [folderRows] = await db.execute(
      'SELECT identificacao FROM streamings WHERE codigo = ? AND codigo_cliente = ?',
      [folderId, userId]
    );
    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const folderName = folderRows[0].identificacao;
    const userLogin = req.user.email.split('@')[0];
    const folderPath = `/${userLogin}/${folderName}/`;

    const [rows] = await db.execute(
      `SELECT 
        codigo as id,
        video as nome,
        path_video as url,
        duracao_segundos as duracao,
        tamanho_arquivo as tamanho
       FROM playlists_videos 
       WHERE path_video LIKE ?
       ORDER BY codigo`,
      [`%${folderPath}%`]
    );

    const videos = rows.map(video => {
      let url;
      if (video.url.startsWith('http')) {
        url = video.url;
      } else {
        if (video.url.includes('mp4:')) {
          url = video.url;
        } else {
          url = wowzaService.buildVideoUrl(userLogin, folderName, video.nome).hlsUrl;
        }
      }
      return {
        id: video.id,
        nome: video.nome,
        url,
        duracao: video.duracao,
        tamanho: video.tamanho,
        originalPath: video.url,
        folder: folderName,
        user: userLogin
      };
    });

    res.json(videos);
  } catch (err) {
    console.error('Erro ao buscar vídeos:', err);
    res.status(500).json({ error: 'Erro ao buscar vídeos', details: err.message });
  }
});

router.post('/upload', authMiddleware, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const userId = req.user.id;
    const userLogin = req.user.email.split('@')[0];
    const folderId = req.query.folder_id || 'default';
    const duracao = parseInt(req.body.duracao) || 0;
    const tamanho = parseInt(req.body.tamanho) || req.file.size;

    const [userRows] = await db.execute(
      `SELECT 
        s.codigo_servidor, s.identificacao as folder_name,
        s.espaco, s.espaco_usado
       FROM streamings s 
       WHERE s.codigo = ? AND s.codigo_cliente = ?`,
      [folderId, userId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const userData = userRows[0];
    const serverId = userData.codigo_servidor || 1;
    const folderName = userData.folder_name;

    const spaceMB = Math.ceil(tamanho / (1024 * 1024));
    const availableSpace = userData.espaco - userData.espaco_usado;

    if (spaceMB > availableSpace) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ 
        error: `Espaço insuficiente. Necessário: ${spaceMB}MB, Disponível: ${availableSpace}MB` 
      });
    }

    await SSHManager.createUserDirectory(serverId, userLogin);
    await SSHManager.createUserFolder(serverId, userLogin, folderName);

    const remotePath = `/usr/local/WowzaStreamingEngine/content/${userLogin}/${folderName}/${req.file.filename}`;
    await SSHManager.uploadFile(serverId, req.file.path, remotePath);
    await fs.unlink(req.file.path);

    const relativePath = `/${userLogin}/${folderName}/${req.file.filename}`;

    const [result] = await db.execute(
      `INSERT INTO playlists_videos (
        codigo_playlist, path_video, video, width, height, 
        bitrate, duracao, duracao_segundos, tipo, ordem, tamanho_arquivo
      ) VALUES (0, ?, ?, 1920, 1080, 2500, ?, ?, 'video', 0, ?)`,
      [relativePath, req.file.originalname, '00:00:00', duracao, tamanho]
    );

    await db.execute(
      'UPDATE streamings SET espaco_usado = espaco_usado + ? WHERE codigo = ?',
      [spaceMB, folderId]
    );

    res.status(201).json({
      id: result.insertId,
      nome: req.file.originalname,
      url: relativePath,
      duracao,
      tamanho
    });
  } catch (err) {
    console.error('Erro no upload:', err);
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ error: 'Erro no upload do vídeo', details: err.message });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const videoId = req.params.id;
    const userId = req.user.id;
    const userLogin = req.user.email.split('@')[0];

    const [videoRows] = await db.execute(
      'SELECT path_video, video, tamanho_arquivo FROM playlists_videos WHERE codigo = ?',
      [videoId]
    );
    if (videoRows.length === 0) {
      return res.status(404).json({ error: 'Vídeo não encontrado' });
    }

    const video = videoRows[0];

    if (!video.path_video.includes(`/${userLogin}/`)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const [serverRows] = await db.execute(
      `SELECT s.codigo_servidor 
       FROM streamings s 
       WHERE s.codigo_cliente = ? 
       LIMIT 1`,
      [userId]
    );

    const serverId = serverRows.length > 0 ? serverRows[0].codigo_servidor : 1;

    try {
      const remotePath = `/usr/local/WowzaStreamingEngine/content${video.path_video}`;
      await SSHManager.deleteFile(serverId, remotePath);
    } catch (fileError) {
      console.warn('Erro ao remover arquivo físico:', fileError.message);
    }

    if (video.tamanho_arquivo) {
      const spaceMB = Math.ceil(video.tamanho_arquivo / (1024 * 1024));
      await db.execute(
        'UPDATE streamings SET espaco_usado = GREATEST(espaco_usado - ?, 0) WHERE codigo_cliente = ?',
        [spaceMB, userId]
      );
    }

    await db.execute(
      'DELETE FROM playlists_videos WHERE codigo = ?',
      [videoId]
    );

    res.json({ success: true, message: 'Vídeo removido com sucesso' });
  } catch (err) {
    console.error('Erro ao remover vídeo:', err);
    res.status(500).json({ error: 'Erro ao remover vídeo', details: err.message });
  }
});

module.exports = router;
