const express = require('express');
const authMiddleware = require('../utils/auth');
const { User, Session, Role } = require('../utils/db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
require('dotenv').config();

const router = express.Router();

router.get('/login', (req, res) => {
    res.render('pages/login', { error: null });
});

router.post('/login', async (req, res) => {
    let { username, password } = req.body;

    try {
        // Solução robusta: garante que o username comece com @ para a busca no banco
        if (username && !username.startsWith('@')) {
            username = '@' + username;
        }

        const user = await User.findOne({ 
            where: { username },
            include: [Role]
        });

        if (!user || !(await bcrypt.compare(password, user.passwordhash))) {
            return res.render('pages/login', { error: 'Usuário ou senha incorretos' });
        }

        if (user.roleId > 11) {
            return res.render('pages/login', { error: 'Acesso negado: Cargo insuficiente' });
        }

        // Cria uma nova sessão compatível com o Teco
        const publicid = crypto.randomUUID();
        const cookieValue = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias

        await Session.create({
            publicid,
            userId: user.id,
            cookie: cookieValue,
            expiresat: expiresAt
        });

        res.cookie('teco_sessid', cookieValue, { 
            expires: expiresAt, 
            httpOnly: true,
            path: '/'
        });

        res.redirect('/');
    } catch (error) {
        console.error('Login Error:', error);
        res.render('pages/login', { error: 'Erro interno no servidor' });
    }
});

// A partir daqui, todas as rotas de páginas exigem estar logado no Teco e cargo <= 11
router.use(authMiddleware);

router.get('/', (req, res) => {
    res.render('pages/home');
});

router.use('/scrobble', require('./scrobble'));

module.exports = router;
