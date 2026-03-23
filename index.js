const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const expressLayouts = require('express-ejs-layouts');
const { syncDb } = require('./server/utils/db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações globais
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layout/mainlayout');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// Rota do roteador principal de páginas
app.use('/', require('./server/pages/router'));

// Rota do roteador principal de api
app.use('/api', require('./server/api/router'));


syncDb().then(() => {
    app.listen(PORT, () => {
        console.log(`Boteco Analytics Hub rodando em http://localhost:${PORT}`);
    });
});
