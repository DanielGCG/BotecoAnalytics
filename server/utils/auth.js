const { Session, User, Role } = require('../utils/db');

/**
 * Middleware para validar a sessão do Teco
 * 1. Verifica se existe cookie de sessão
 * 2. Valida no banco se a sessão existe e não expirou
 * 3. Garante que o usuário logado tem cargo <= 11
 */
const authMiddleware = async (req, res, next) => {
    const sessionCookie = req.cookies.teco_sessid;

    if (!sessionCookie) {
        return res.redirect('/login');
    }

    try {
        const session = await Session.findOne({
            where: { cookie: sessionCookie },
            include: [{
                model: User,
                include: [Role]
            }]
        });

        if (!session || new Date() > session.expiresat) {
            return res.redirect('/login');
        }

        // Regra de negócio: cargo <= 11
        if (session.User.roleId > 11) {
            return res.status(403).send('Acesso negado: Seu cargo não tem permissão para este painel.');
        }

        // Salva o usuário na requisição para uso futuro
        req.user = session.User;
        next();
    } catch (error) {
        console.error('Auth Middleware Error:', error);
        res.status(500).send('Erro interno ao validar sessão.');
    }
};

module.exports = authMiddleware;
