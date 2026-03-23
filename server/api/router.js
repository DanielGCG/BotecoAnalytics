const express = require('express');
require('dotenv').config();

const router = express.Router();

router.use('/scrobble', require('./scrobble'));

module.exports = router;
