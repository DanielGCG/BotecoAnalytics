const express = require('express');
const path = require('path');
const { getValidLastFmUsers } = require('../utils/db');
require('dotenv').config();

const router = express.Router();

// Middleware local para o módulo
router.use(express.static(path.join(__dirname, 'public')));


// Página principal do Boteco Scrobble
router.get('/', async (req, res) => {
    try {
        const friends = await getValidLastFmUsers();
        
        const filterUsers = req.query.user ? (Array.isArray(req.query.user) ? req.query.user : req.query.user.split(',')) : ['group'];
        const period = req.query.period || '7day';

        res.render('pages/scrobble/index', {
            title: 'Scrobble Analytics',
            friends,
            filterUsers,
            period
        });
    } catch (error) {
        console.error('Page Error:', error);
        res.status(500).send('Erro ao carregar os dados dos usuários.');
    }
});

module.exports = router;
