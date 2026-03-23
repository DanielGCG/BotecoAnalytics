const { Sequelize, DataTypes, Op } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
    process.env.DB_NAME || 'botecoanalytics',
    process.env.DB_USER || 'root',
    process.env.DB_PASS || 'root',
    {
        host: process.env.DB_HOST || 'db',
        dialect: 'mysql',
        logging: false,
        define: {
            charset: 'utf8mb4',
            collate: 'utf8mb4_unicode_ci'
        }
    }
);

// Conexão separada para o banco do sistema Teco
const sequelizeTeco = new Sequelize(
    process.env.DB_NAME_TECO || 'teco',
    process.env.DB_USER_TECO || 'root',
    process.env.DB_PASS_TECO || 'root',
    {
        host: process.env.DB_HOST_TECO || 'host.docker.internal',
        port: process.env.DB_PORT_TECO || 3306,
        dialect: 'mysql',
        logging: false
    }
);

// Modelo para a tabela 'user' do sistema Teco
const User = sequelizeTeco.define('User', {
    id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
    },
    username: {
        type: DataTypes.STRING(16),
        allowNull: false,
        unique: true
    },
    publicid: {
        type: DataTypes.STRING(36),
        allowNull: false,
        unique: true
    },
    roleId: {
        type: DataTypes.TINYINT.UNSIGNED,
        allowNull: false,
        defaultValue: 20
    },
    passwordhash: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    lastfmusername: {
        type: DataTypes.STRING(64)
    },
    displayName: {
        type: DataTypes.VIRTUAL,
        get() {
            return this.username;
        }
    }
}, {
    tableName: 'user',
    timestamps: false
});

// Modelo para a tabela 'role'
const Role = sequelizeTeco.define('Role', {
    id: {
        type: DataTypes.TINYINT.UNSIGNED,
        primaryKey: true
    },
    name: {
        type: DataTypes.STRING(64)
    }
}, {
    tableName: 'role',
    timestamps: false
});

// Modelo para a tabela 'session'
const Session = sequelizeTeco.define('Session', {
    id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
    },
    publicid: {
        type: DataTypes.STRING(36),
        allowNull: false,
        unique: true
    },
    userId: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
    },
    cookie: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    expiresat: {
        type: DataTypes.DATE,
        allowNull: false
    }
}, {
    tableName: 'session',
    timestamps: false
});

// Relacionamentos para autenticação e autorização
User.belongsTo(Role, { foreignKey: 'roleId' });
Role.hasMany(User, { foreignKey: 'roleId' });
Session.belongsTo(User, { foreignKey: 'userId' });
User.hasMany(Session, { foreignKey: 'userId' });

const Scrobble = sequelize.define('Scrobble', {
    uts: {
        type: DataTypes.BIGINT,
        primaryKey: true,
    },
    user: {
        type: DataTypes.STRING,
        primaryKey: true,
    },
    artist: {
        type: DataTypes.STRING,
        allowNull: false
    },
    track: {
        type: DataTypes.STRING,
        allowNull: false
    },
    album: {
        type: DataTypes.STRING
    },
    date_str: {
        type: DataTypes.STRING
    }
}, {
    tableName: 'sb_scrobbles',
    timestamps: false,
    indexes: [
        { name: 'sb_scrobbles_user_uts', fields: ['user', 'uts'] },
        { name: 'sb_scrobbles_date_str', fields: ['date_str'] }
    ]
});

// Armazenar o gênero dos artistas localmente
const ArtistGenre = sequelize.define('ArtistGenre', {
    artist: {
        type: DataTypes.STRING,
        primaryKey: true
    },
    genre: {
        type: DataTypes.STRING,
        allowNull: false
    }
}, {
    tableName: 'sb_artistgenres',
    timestamps: true
});

const getValidLastFmUsers = async () => {
    const users = await User.findAll({
        where: {
            lastfmusername: {
                [Op.and]: [
                    { [Op.not]: null },
                    { [Op.ne]: '' }
                ]
            }
        },
        attributes: ['lastfmusername'],
        order: [['lastfmusername', 'ASC']]
    });
    
    // Filtra, remove espaços lixo e previne nomes duplicados caso dois usuários usem a mesma conta
    const friendsList = users.map(u => u.lastfmusername ? u.lastfmusername.trim() : '').filter(Boolean);
    return [...new Set(friendsList)];
};

const cleanupOrphanedScrobbles = async (validUsers = null) => {
    try {
        if (!validUsers) {
            validUsers = await getValidLastFmUsers();
        }
        let deletedCount = 0;
        if (validUsers.length > 0) {
            deletedCount = await Scrobble.destroy({
                where: {
                    user: { [Op.notIn]: validUsers }
                }
            });
        } else {
            deletedCount = await Scrobble.destroy({ where: {} });
        }
        if (deletedCount > 0) {
            console.log(`[Database] Limpos ${deletedCount} scrobbles associados a usuários removidos/órfãos.`);
        }
    } catch (cleanupError) {
        console.error('[Database] Failed to cleanup orphaned scrobbles:', cleanupError);
    }
};

const syncDb = async () => {
    try {
        await sequelize.authenticate();
        await sequelizeTeco.authenticate();
        console.log('[Database] Connected to both Boteco and Teco DBs.');
        
        // Sincroniza apenas as tabelas locais do Boteco
        await sequelize.sync();

        await cleanupOrphanedScrobbles();
    } catch (error) {
        console.error('[Database] Failed to connect:', error);
    }
};

module.exports = { sequelize, sequelizeTeco, Scrobble, ArtistGenre, User, Role, Session, syncDb, getValidLastFmUsers, cleanupOrphanedScrobbles };
