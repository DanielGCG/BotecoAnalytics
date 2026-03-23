-- Criar usuário botecoanalytics se não existir
CREATE USER IF NOT EXISTS 'botecoanalytics'@'%' IDENTIFIED BY '160880';

-- Conceder permissões
GRANT ALL PRIVILEGES ON botecoanalytics.* TO 'botecoanalytics'@'%';
GRANT ALL PRIVILEGES ON teco.* TO 'botecoanalytics'@'localhost' IDENTIFIED BY '160880';

FLUSH PRIVILEGES;
