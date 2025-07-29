  const express = require('express');
  const cors = require('cors');
  const path = require('path');
  const db = require('./config/database');
  const SSHManager = require('./config/SSHManager');


  // Importar rotas
  const authRoutes = require('./routes/auth');
  const foldersRoutes = require('./routes/folders');
  const videosRoutes = require('./routes/videos');
  const playlistsRoutes = require('./routes/playlists');
  const agendamentosRoutes = require('./routes/agendamentos');
  const comerciaisRoutes = require('./routes/comerciais');
  const downloadyoutubeRoutes = require('./routes/downloadyoutube');
  const espectadoresRoutes = require('./routes/espectadores');
  const streamingRoutes = require('./routes/streaming');
  const relayRoutes = require('./routes/relay');
  const logosRoutes = require('./routes/logos');
  const transmissionSettingsRoutes = require('./routes/transmission-settings');
  const ftpRoutes = require('./routes/ftp');
  const serversRoutes = require('./routes/servers');

  const app = express();
  const PORT = process.env.PORT || 3001;
  const isProduction = process.env.NODE_ENV === 'production';

  // Middlewares
  app.use(cors({
    origin: isProduction ? [
      'http://samhost.wcore.com.br',
      'https://samhost.wcore.com.br',
      'http://samhost.wcore.com.br:3000'
    ] : [
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    ],
    credentials: true
  }));
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Servir arquivos estáticos do Wowza
  // Middleware personalizado para servir arquivos de vídeo
  app.use('/content', async (req, res, next) => {
    try {
      // Extrair informações do caminho
      const requestPath = req.path;
      console.log(`📹 Solicitação de vídeo: ${requestPath}`);
      
      // Verificar se é um arquivo de vídeo ou playlist
      const isVideo = /\.(mp4|avi|mov|wmv|flv|webm|mkv|m3u8|ts)$/i.test(requestPath);
      
      if (!isVideo) {
        return res.status(404).json({ error: 'Arquivo não encontrado' });
      }
      
      // Configurar headers para streaming de vídeo
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      res.setHeader('Accept-Ranges', 'bytes');
      
      // Definir Content-Type baseado na extensão
      if (requestPath.includes('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      } else if (requestPath.includes('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
      } else {
        res.setHeader('Content-Type', 'video/mp4');
      }
      
      res.setHeader('Cache-Control', 'public, max-age=3600');
      
      // Buscar servidor Wowza dinamicamente baseado no usuário
      const pathParts = requestPath.split('/').filter(part => part);
      let wowzaHost = '51.222.156.223'; // Servidor padrão
      
      if (pathParts.length >= 1) {
        const userLogin = pathParts[0];
        
        try {
          // Buscar servidor do usuário no banco
          const [userRows] = await db.execute(
            `SELECT ws.ip 
             FROM streamings s 
             JOIN wowza_servers ws ON s.codigo_servidor = ws.codigo 
             WHERE s.login = ? OR s.identificacao = ? 
             LIMIT 1`,
            [userLogin, userLogin]
          );
          
          if (userRows.length > 0) {
            wowzaHost = userRows[0].ip;
            console.log(`🎯 Servidor específico encontrado para ${userLogin}: ${wowzaHost}`);
          }
        } catch (dbError) {
          console.warn('⚠️ Erro ao buscar servidor do usuário, usando padrão:', dbError.message);
        }
      }
      
      // Construir URL correta para VOD
      let wowzaUrl;
      
      // Detectar se é um arquivo MP4 e construir URL apropriada
      if (requestPath.includes('.mp4') && !requestPath.includes('playlist.m3u8')) {
        // Para arquivos MP4 diretos, usar formato mp4:
        const cleanPath = requestPath.replace(/^\/+/, '');
        wowzaUrl = `http://${wowzaHost}:1935/vod/_definst_/mp4:${cleanPath}`;
      } else if (requestPath.includes('playlist.m3u8')) {
        // Para playlists HLS, construir URL correta
        const cleanPath = requestPath.replace('playlist.m3u8', '').replace(/^\/+/, '').replace(/\/+$/, '');
        
        // Verificar se o caminho contém um arquivo MP4
        if (cleanPath.includes('.mp4')) {
          const mp4Path = cleanPath.replace('.mp4', '');
          wowzaUrl = `http://${wowzaHost}:1935/vod/_definst_/mp4:${mp4Path}.mp4/playlist.m3u8`;
        } else {
          wowzaUrl = `http://${wowzaHost}:1935/vod/_definst_/${cleanPath}/playlist.m3u8`;
        }
      } else {
        // Para outros tipos de arquivo
        wowzaUrl = `http://${wowzaHost}:1935/vod/_definst_${requestPath}`;
      }
      
      console.log(`🔗 Redirecionando para: ${wowzaUrl}`);
      
      // Fazer proxy da requisição para o servidor Wowza
      const fetch = require('node-fetch');
      const authHeader = Buffer.from('admin:FK38Ca2SuE6jvJXed97VMn').toString('base64');
      
      const wowzaResponse = await fetch(wowzaUrl, {
        method: req.method,
        headers: {
          'Range': req.headers.range || '',
          'User-Agent': 'Streaming-System/1.0',
          'Authorization': `Basic ${authHeader}`,
          'Accept': '*/*'
        },
        timeout: 30000
      });
      
      if (!wowzaResponse.ok) {
        console.log(`❌ Erro do Wowza (${wowzaResponse.status}): ${wowzaResponse.statusText}`);
        
        // Tentar URLs alternativas
        const alternativeUrls = [
          `http://${wowzaHost}:1935/vod${requestPath}`,
          `http://${wowzaHost}:1935/live${requestPath}`,
          `http://${wowzaHost}:1935/samhost${requestPath}`
        ];
        
        for (const altUrl of alternativeUrls) {
          console.log(`🔄 Tentando URL alternativa: ${altUrl}`);
          
          try {
            const altResponse = await fetch(altUrl, {
              method: req.method,
              headers: {
                'Range': req.headers.range || '',
                'User-Agent': 'Streaming-System/1.0'
              },
              timeout: 10000
            });
            
            if (altResponse.ok) {
              console.log(`✅ URL alternativa funcionou: ${altUrl}`);
              
              // Copiar headers da resposta
              altResponse.headers.forEach((value, key) => {
                res.setHeader(key, value);
              });
              
              altResponse.body.pipe(res);
              return;
            }
          } catch (altError) {
            console.log(`❌ URL alternativa falhou: ${altUrl} - ${altError.message}`);
          }
        }
        
        return res.status(404).json({ 
          error: 'Vídeo não encontrado no servidor de streaming',
          details: `Tentativas falharam para: ${wowzaUrl}`,
          suggestions: 'Verifique se o arquivo existe no servidor Wowza'
        });
      }
      
      // Copiar headers da resposta do Wowza
      wowzaResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      
      // Fazer pipe do stream
      wowzaResponse.body.pipe(res);
      
    } catch (error) {
      console.error('❌ Erro no middleware de vídeo:', error);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });
  
  // Servir arquivos estáticos do frontend em produção
  if (isProduction) {
    app.use(express.static(path.join(__dirname, '../dist')));
    
    // Catch all handler: send back React's index.html file for SPA routing
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api/')) {
        res.sendFile(path.join(__dirname, '../dist/index.html'));
      }
    });
  }

  // Rotas da API
  app.use('/api/auth', authRoutes);
  app.use('/api/folders', foldersRoutes);
  app.use('/api/videos', videosRoutes);
  app.use('/api/playlists', playlistsRoutes);
  app.use('/api/agendamentos', agendamentosRoutes);
  app.use('/api/comerciais', comerciaisRoutes);
  app.use('/api/downloadyoutube', downloadyoutubeRoutes);
  app.use('/api/espectadores', espectadoresRoutes);
  app.use('/api/streaming', streamingRoutes);
  app.use('/api/relay', relayRoutes);
  app.use('/api/logos', logosRoutes);
  app.use('/api/transmission-settings', transmissionSettingsRoutes);
  app.use('/api/ftp', ftpRoutes);
  app.use('/api/servers', serversRoutes);

  // Rota de teste
  app.get('/api/test', (req, res) => {
    res.json({ message: 'API funcionando!', timestamp: new Date().toISOString() });
  });

  // Rota de health check
  app.get('/api/health', async (req, res) => {
    try {
      const dbConnected = await db.testConnection();
      res.json({
        status: 'ok',
        database: dbConnected ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        database: 'disconnected',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Middleware de tratamento de erros
  app.use((error, req, res, next) => {
    console.error('Erro não tratado:', error);
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Arquivo muito grande' });
    }
    
    if (error.message.includes('Tipo de arquivo não suportado')) {
      return res.status(400).json({ error: 'Tipo de arquivo não suportado' });
    }
    
    res.status(500).json({ error: 'Erro interno do servidor' });
  });

  // Rota 404
  app.use('*', (req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' });
  });

  // Iniciar servidor
  async function startServer() {
    try {
      // Testar conexão com banco
      const dbConnected = await db.testConnection();
      
      if (!dbConnected) {
        console.error('❌ Não foi possível conectar ao banco de dados');
        process.exit(1);
      }

      app.listen(PORT, () => {
        console.log(`🚀 Servidor rodando na porta ${PORT}`);
        console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
        console.log(`🔧 API test: http://localhost:${PORT}/api/test`);
        console.log(`🔗 SSH Manager inicializado para uploads remotos`);
      });
      
      // Cleanup ao fechar aplicação
      process.on('SIGINT', () => {
        console.log('\n🔌 Fechando conexões SSH...');
        SSHManager.closeAllConnections();
        process.exit(0);
      });
      
      process.on('SIGTERM', () => {
        console.log('\n🔌 Fechando conexões SSH...');
        SSHManager.closeAllConnections();
        process.exit(0);
      });
    } catch (error) {
      console.error('❌ Erro ao iniciar servidor:', error);
      process.exit(1);
    }
  }

  startServer();