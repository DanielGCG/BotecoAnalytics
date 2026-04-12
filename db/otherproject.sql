CREATE DATABASE IF NOT EXISTS teco;
USE teco;

-- ==========================
-- TABELAS DE USUÁRIO
-- ==========================
CREATE TABLE IF NOT EXISTS role (
    id TINYINT UNSIGNED PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    name VARCHAR(64)
);

INSERT INTO role (id, publicid, name) VALUES
(1, '83d26732-c7f9-4623-bc75-1a13470402b4', 'dono'),
(5, '6c9135fc-3e28-4475-be82-f58c4957f950', 'admin'),
(10, '33a2e796-03f3-4fd6-912a-04987a052e69', 'moderador'),
(11, 'f268b8b0-880c-4ef7-8f5f-f61b0722cc2c', 'botecor'),
(20, '4078864a-2f47-495f-9e32-3f7cb5f98897', 'usuário');

CREATE TABLE IF NOT EXISTS user (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(16) NOT NULL UNIQUE,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    roleId TINYINT UNSIGNED NOT NULL DEFAULT 20,
    passwordhash VARCHAR(255) NOT NULL,
    birthday DATE DEFAULT CURRENT_DATE,
    pronouns VARCHAR(16),
    bio VARCHAR(160),
    backgroundimage VARCHAR(255),
    profileimage VARCHAR(255),
    lastfmusername VARCHAR(64),
    postcount INT UNSIGNED NOT NULL DEFAULT 0,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lastaccess TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (roleId) REFERENCES role(id) ON DELETE SET DEFAULT
);

DELIMITER //
CREATE TRIGGER primeirousuarioadmin
BEFORE INSERT ON user
FOR EACH ROW
BEGIN
    IF (SELECT COUNT(*) FROM user) = 0 THEN
        SET NEW.roleId = 1;
    END IF;
END;
//
DELIMITER ;

CREATE TABLE IF NOT EXISTS follow (
    publicid VARCHAR(36) NOT NULL UNIQUE,
    followerUserId INT UNSIGNED NOT NULL,
    followedUserId INT UNSIGNED NOT NULL,
    CHECK (followerUserId != followedUserId),
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (followerUserId, followedUserId),
    FOREIGN KEY (followerUserId) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (followedUserId) REFERENCES user(id) ON DELETE CASCADE
);

-- ==========================
-- TABELA DE SESSÃO
-- ==========================
CREATE TABLE IF NOT EXISTS session (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    userId INT UNSIGNED NOT NULL,
    cookie VARCHAR(255) NOT NULL,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expiresat TIMESTAMP NOT NULL,
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
);

-- ==========================
-- TABELAS DE NOTIFICAÇÃO
-- ==========================
CREATE TABLE IF NOT EXISTS notification (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    targetUserId INT UNSIGNED NOT NULL,
    type ENUM('system','everyone','followaccept', 'followarequest', 'dm', 'cutucado', 'postcomment', 'postlike', 'postrepost', 'info') NOT NULL DEFAULT 'info',
    title VARCHAR(160) NOT NULL,
    body TEXT,
    link VARCHAR(255),
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expiresat TIMESTAMP DEFAULT NULL,
    readat TIMESTAMP NULL,
    FOREIGN KEY (targetUserId) REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX idx_notif_cleanup ON notification(targetUserId, readat);

-- notificações everyone com mais de 7 dias serão apagadas automaticamente
DELIMITER //
CREATE EVENT IF NOT EXISTS deletanotificacoeveryone
ON SCHEDULE EVERY 1 HOUR
DO
BEGIN
    DELETE FROM notification
    WHERE type = 'everyone' AND createdat < NOW() - INTERVAL 7 DAY;
END;
//
DELIMITER ;

-- notificações expiradas serão apagadas automaticamente
DELIMITER //
CREATE EVENT IF NOT EXISTS deletanotificacoesexpiradas
ON SCHEDULE EVERY 1 HOUR
DO
BEGIN
    DELETE FROM notification
    WHERE expiresat IS NOT NULL AND expiresat < NOW();
END;
//
DELIMITER ;

-- mantemos apenas as últimas 5 notificações lidas por usuário
DELIMITER //
CREATE EVENT IF NOT EXISTS limpaanotificacoeslidas
ON SCHEDULE EVERY 1 DAY
DO
BEGIN
    DELETE FROM notification 
    WHERE id IN (
        SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY targetUserId ORDER BY createdat DESC) as rn 
            FROM notification 
            WHERE readat IS NOT NULL
        ) as t 
        WHERE rn > 5
    );
END;
//
DELIMITER ;

-- ==========================
-- TABELA DE RODINHA E POSTS
-- ==========================
CREATE TABLE IF NOT EXISTS rodinha (
    userId INT UNSIGNED NOT NULL,
    targetUserId INT UNSIGNED NOT NULL,
    CHECK (userId != targetUserId),
    PRIMARY KEY (userId, targetUserId),
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (targetUserId) REFERENCES user(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS post (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    authorUserId INT UNSIGNED NOT NULL,
    isrodinha BOOLEAN NOT NULL DEFAULT FALSE,
    attachedPostId INT UNSIGNED DEFAULT NULL,
    content TEXT,
    type ENUM('post', 'repost', 'reply', 'comment') NOT NULL DEFAULT 'post',
    likecount INT UNSIGNED NOT NULL DEFAULT 0,
    replycount INT UNSIGNED NOT NULL DEFAULT 0,
    repostcount INT UNSIGNED NOT NULL DEFAULT 0,
    bookmarkcount INT UNSIGNED NOT NULL DEFAULT 0,
    isedited BOOLEAN NOT NULL DEFAULT FALSE,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (authorUserId) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (attachedPostId) REFERENCES post(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS postmedia (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    postId INT UNSIGNED NOT NULL,
    type ENUM('image/gif','video') NOT NULL,
    url VARCHAR(255) NOT NULL,
    FOREIGN KEY (postId) REFERENCES post(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS postmention (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    postId INT UNSIGNED NOT NULL,
    userId INT UNSIGNED NOT NULL,
    FOREIGN KEY (postId) REFERENCES post(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
);

-- não podemos nos mencionar em posts feitos por nós mesmos
DELIMITER //
CREATE TRIGGER bloqueiarmencionarsimesmo
BEFORE INSERT ON postmention
FOR EACH ROW
BEGIN
    DECLARE postAuthorId INT UNSIGNED;
    SELECT authorUserId INTO postAuthorId FROM post WHERE id = NEW.postId;
    IF postAuthorId = NEW.userId THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Usuário não pode se mencionar em seus próprios posts.';
    END IF;
END;
//
DELIMITER ; 

CREATE TABLE IF NOT EXISTS postlike (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    userId INT UNSIGNED NOT NULL,
    postId INT UNSIGNED NOT NULL,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (userId, postId),
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (postId) REFERENCES post(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS postbookmark (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    userId INT UNSIGNED NOT NULL,
    postId INT UNSIGNED NOT NULL,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (userId, postId),
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (postId) REFERENCES post(id) ON DELETE CASCADE
);

-- trigger para atualizar contadores de like, reply e repostcount na tabela post
DELIMITER //
CREATE TRIGGER atualizacontadorespost_like
AFTER INSERT ON postlike
FOR EACH ROW
BEGIN
    UPDATE post SET likecount = likecount + 1 WHERE id = NEW.postId;
END;
//
DELIMITER ;
DELIMITER //
CREATE TRIGGER atualizacontadorespost_delete_like
AFTER DELETE ON postlike
FOR EACH ROW
BEGIN
    UPDATE post SET likecount = likecount - 1 WHERE id = OLD.postId;
END;
//
DELIMITER ;

DELIMITER //
CREATE TRIGGER atualizacontadorespost_bookmark
AFTER INSERT ON postbookmark
FOR EACH ROW
BEGIN
    UPDATE post SET bookmarkcount = bookmarkcount + 1 WHERE id = NEW.postId;
END;
//
DELIMITER ;
DELIMITER //
CREATE TRIGGER atualizacontadorespost_delete_bookmark
AFTER DELETE ON postbookmark
FOR EACH ROW
BEGIN
    UPDATE post SET bookmarkcount = bookmarkcount - 1 WHERE id = OLD.postId;
END;
//
DELIMITER ; 

-- ==========================
-- TABELA DE GALERIA
-- ==========================
CREATE TABLE IF NOT EXISTS gallery (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    description TEXT,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    ispublic BOOLEAN NOT NULL DEFAULT FALSE,
    coverurl VARCHAR(255),
    backgroundurl VARCHAR(255),
    backgroundfill VARCHAR(10) NOT NULL DEFAULT 'cover',
    backgroundcolor VARCHAR(7) NOT NULL DEFAULT '#e2e1cf',
    cardcolor VARCHAR(7) NOT NULL DEFAULT '#ffffff',
    fontcolor VARCHAR(7) NOT NULL DEFAULT '#3E3F29',
    fontfamily VARCHAR(50) NOT NULL DEFAULT 'Inter',
    gridxsize INT NOT NULL DEFAULT 12,
    gridysize INT NOT NULL DEFAULT 12,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    editedat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    createdbyUserId INT UNSIGNED,
    FOREIGN KEY (createdbyUserId) REFERENCES user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS gallerycontributor (
    userId INT UNSIGNED NOT NULL,
    galleryId INT UNSIGNED NOT NULL,
    PRIMARY KEY (userId, galleryId),
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (galleryId) REFERENCES gallery(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS galleryitem (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    galleryId INT UNSIGNED NOT NULL,
    type ENUM('image/gif','video','audio', 'text', 'embed') NOT NULL,
    title VARCHAR(160),
    showtitle BOOLEAN NOT NULL DEFAULT TRUE,
    textbody TEXT,
    coverurl VARCHAR(255),
    covercolor VARCHAR(7),
    contenturl VARCHAR(255),
    objectfit VARCHAR(10) NOT NULL DEFAULT 'cover',
    startpositionx INT,
    startpositiony INT,
    endpositionx INT,
    endpositiony INT,
    positionz INT NOT NULL DEFAULT 1,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    editedat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    editedbyUserId INT UNSIGNED,
    FOREIGN KEY (editedbyUserId) REFERENCES user(id) ON DELETE SET NULL,
    FOREIGN KEY (galleryId) REFERENCES gallery(id) ON DELETE CASCADE
);

-- ==========================
-- TABELA DE WATCHLIST
-- ==========================
CREATE TABLE IF NOT EXISTS movie (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    title VARCHAR(160) NOT NULL,
    overview TEXT,
    popularity FLOAT,
    type VARCHAR(10) NOT NULL CHECK (type IN ('movie','tv')),
    originallang VARCHAR(5) NOT NULL,
    posterurl VARCHAR(255),
    backdropurl VARCHAR(255),
    releasedate DATE,
    voteaverage FLOAT,
    votecount INT,
    voteboteco FLOAT,
    iswatched BOOLEAN DEFAULT FALSE,
    createdbyUserId INT UNSIGNED,
    createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (createdbyUserId) REFERENCES user(id) ON DELETE SET NULL
);

-- ==========================
-- TABELAS DE IMAGEM DO DIA
-- ==========================
CREATE TABLE IF NOT EXISTS imagemdodiaborder (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    name VARCHAR(64) NOT NULL,
    url VARCHAR(255) NOT NULL,
    createdbyUserId INT UNSIGNED,
    createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (createdbyUserId) REFERENCES user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS imagemdodia (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    position INT NOT NULL,
    url VARCHAR(255) NOT NULL,
    text VARCHAR(32) NOT NULL,
    borderId INT UNSIGNED NOT NULL DEFAULT 1,
    createdbyUserId INT UNSIGNED,
    createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    activatedat TIMESTAMP NULL,
    FOREIGN KEY (createdbyUserId) REFERENCES user(id) ON DELETE SET NULL,
    FOREIGN KEY (borderId) REFERENCES imagemdodiaborder(id) ON DELETE CASCADE
);

-- ==========================
-- TABELAS DE CHATS
-- ==========================
CREATE TABLE IF NOT EXISTS chattopic (
    name VARCHAR(64) PRIMARY KEY,
    description VARCHAR(255) NULL
);

INSERT INTO chattopic (name, description) VALUES
('Geral', 'Sem tópico definido, fale sobre o que quiser.'),
('Fofoca', 'Todo mundo gosta!'),
('UFRJ', 'Estão abertas as portas para a coitadolândia.');

CREATE TABLE IF NOT EXISTS chat (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    title VARCHAR(160) NOT NULL,
    chatTopicName VARCHAR(64) NULL DEFAULT 'Geral',
    lastChatMessageId INT UNSIGNED DEFAULT NULL,
    lastmessageat TIMESTAMP NULL,
    createdbyUserId INT UNSIGNED,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chatTopicName) REFERENCES chattopic(name) ON DELETE SET NULL,
    FOREIGN KEY (createdbyUserId) REFERENCES user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS chatmessages (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    chatId INT UNSIGNED NOT NULL,
    userId INT UNSIGNED NOT NULL,
    message TEXT NOT NULL,
    isedited BOOLEAN NOT NULL DEFAULT FALSE,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chatId) REFERENCES chat(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
);

DELIMITER //
CREATE TRIGGER update_chat_metadata
AFTER INSERT ON chatmessages
FOR EACH ROW
BEGIN
    UPDATE chat 
    SET lastChatMessageId = NEW.id, 
        lastmessageat = NEW.createdat 
    WHERE id = NEW.chatId;
END;
//
DELIMITER ;

INSERT INTO chat (publicid, title, chatTopicName) VALUES
('e4e17c9d-15b5-451e-8dee-748956144ed2', 'Geral', 'Geral');

-- ==========================
-- TABELAS DE DMS
-- ==========================
CREATE TABLE IF NOT EXISTS dm (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    userId1 INT UNSIGNED NOT NULL,
    userId2 INT UNSIGNED NOT NULL,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniquedm (userId1, userId2),
    CHECK (userId1 != userId2),
    FOREIGN KEY (userId1) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (userId2) REFERENCES user(id) ON DELETE CASCADE
);

-- evitar que duas dms sejam criadas entre os mesmos usuários
DELIMITER //
CREATE TRIGGER evitarduplicadms
BEFORE INSERT ON dm
FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM dm WHERE (userId1 = NEW.userId1 AND userId2 = NEW.userId2) OR (userId1 = NEW.userId2 AND userId2 = NEW.userId1)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DM entre esses usuários já existe.';
    END IF;
END;
//
DELIMITER ;

CREATE TABLE IF NOT EXISTS dmmessage (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    dmId INT UNSIGNED NOT NULL,
    userId INT UNSIGNED NOT NULL,
    message TEXT NOT NULL,
    isedited BOOLEAN NOT NULL DEFAULT FALSE,
    isread BOOLEAN NOT NULL DEFAULT FALSE,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (dmId) REFERENCES dm(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
);

-- ==========================
-- TABELA DE CARTINHAS
-- ==========================
CREATE TABLE IF NOT EXISTS cartinha (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    senderUserId INT UNSIGNED,
    recipientUserId INT UNSIGNED NOT NULL,
    title VARCHAR(160) NOT NULL,
    body TEXT,
    contenturl VARCHAR(255),
    isanonymous BOOLEAN NOT NULL DEFAULT FALSE,
    isread BOOLEAN NOT NULL DEFAULT FALSE,
    isfavorited BOOLEAN NOT NULL DEFAULT FALSE,
    readat TIMESTAMP NULL,
    favoritedat TIMESTAMP NULL,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (senderUserId) REFERENCES user(id) ON DELETE SET NULL,
    FOREIGN KEY (recipientUserId) REFERENCES user(id) ON DELETE CASCADE
);

-- trigger para deletar cartinhas lidas não favoritadas com mais de 30 dias
DELIMITER //
CREATE EVENT IF NOT EXISTS deletacartinhaslidas
ON SCHEDULE EVERY 1 DAY
DO
BEGIN
    DELETE FROM cartinha
    WHERE isread = TRUE AND isfavorited = FALSE AND readat < NOW() - INTERVAL 30 DAY;
END;
//
DELIMITER ;

-- Adicionar FK circular do chat após a criação das tabelas
ALTER TABLE chat ADD CONSTRAINT fk_last_message 
FOREIGN KEY (lastChatMessageId) REFERENCES chatmessages(id) ON DELETE SET NULL;

-- ==========================
-- TABELA DE BADGES
-- ==========================

CREATE TABLE IF NOT EXISTS badge (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    name VARCHAR(64) NOT NULL,
    description TEXT,
    url VARCHAR(255),
    createdbyUserId INT UNSIGNED,
    createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (createdbyUserId) REFERENCES user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS badgeuser (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    publicid VARCHAR(36) NOT NULL UNIQUE,
    userId INT UNSIGNED NOT NULL,
    badgeId INT UNSIGNED NOT NULL,
    createdbyUserId INT UNSIGNED,
    createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (userId, badgeId),
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (badgeId) REFERENCES badge(id) ON DELETE CASCADE,
    FOREIGN KEY (createdbyUserId) REFERENCES user(id) ON DELETE SET NULL
);

-- ==========================
-- TABELA DE CONFIGURAÇÕES
-- ==========================
CREATE TABLE IF NOT EXISTS systemconfig (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `key` VARCHAR(64) NOT NULL UNIQUE,
    `value` TEXT NOT NULL,
    description VARCHAR(255) NULL
);

INSERT INTO systemconfig (`key`, `value`, `description`) VALUES
('marquee', 'Bem-vindo ao Site do Boteco!', 'Texto que aparece no letreiro do topo do site');