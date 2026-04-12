const express = require('express');
const scrobbleRouter = require('./scrobble');
require('dotenv').config();

const router = express.Router();

// Aplica roteamento do scrobble no /scrobble
router.use('/scrobble', scrobbleRouter);

// Alias direto para as rotas de scrobble na raiz da API
// Assim /api/widget/... passa a funcionar perfeitamente sem gambiarra de req.url
router.use('/', scrobbleRouter);

module.exports = router;
