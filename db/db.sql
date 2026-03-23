-- Criação da tabela de Scrobbles
CREATE TABLE IF NOT EXISTS `sb_scrobbles` (
  `uts` BIGINT NOT NULL,
  `user` VARCHAR(255) NOT NULL,
  `artist` VARCHAR(255) NOT NULL,
  `track` VARCHAR(255) NOT NULL,
  `album` VARCHAR(255),
  `date_str` VARCHAR(255),
  PRIMARY KEY (`uts`, `user`),
  INDEX `sb_scrobbles_user_uts` (`user`, `uts`),
  INDEX `sb_scrobbles_date_str` (`date_str`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Criação da tabela de Gêneros de Artistas
CREATE TABLE IF NOT EXISTS `sb_artistgenres` (
  `artist` VARCHAR(255) NOT NULL,
  `genre` VARCHAR(255) NOT NULL,
  `createdAt` DATETIME NOT NULL,
  `updatedAt` DATETIME NOT NULL,
  PRIMARY KEY (`artist`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;