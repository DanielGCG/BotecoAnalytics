const express = require('express');
require('dotenv').config();

const router = express.Router();

router.use('/scrobble', require('./scrobble'));

// Alias direto para o widget na raiz da api para facilitar a URL
router.use('/widget', (req, res, next) => {
    // Redireciona a chamada silenciosamente para o scrobble router 
    req.url = '/widget' + req.url;
    require('./scrobble')(req, res, next);
});

module.exports = router;
