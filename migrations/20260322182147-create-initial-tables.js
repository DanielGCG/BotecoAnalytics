'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. A tabela 'User' virá do outro banco, não criamos ela aqui.
    // Mas precisamos garantir que as tabelas do Scrobble existem.

    // 2. Create Scrobbles
    await queryInterface.createTable('sb_scrobbles', {
      uts: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        allowNull: false
      },
      user: {
        type: Sequelize.STRING,
        primaryKey: true,
        allowNull: false
      },
      artist: {
        type: Sequelize.STRING,
        allowNull: false
      },
      track: {
        type: Sequelize.STRING,
        allowNull: false
      },
      album: {
        type: Sequelize.STRING
      },
      date_str: {
        type: Sequelize.STRING
      }
    });

    // Indexes for Scrobbles
    await queryInterface.addIndex('sb_scrobbles', ['user', 'uts'], { name: 'sb_scrobbles_user_uts' });
    await queryInterface.addIndex('sb_scrobbles', ['date_str'], { name: 'sb_scrobbles_date_str' });

    // 3. Create ArtistGenres
    await queryInterface.createTable('sb_artistgenres', {
      artist: {
        type: Sequelize.STRING,
        primaryKey: true,
        allowNull: false
      },
      genre: {
        type: Sequelize.STRING,
        allowNull: false
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('sb_scrobbles');
    await queryInterface.dropTable('sb_artistgenres');
  }
};
