const express = require('express');
const app = express();

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Clutch Arena API is running smoothly!' });
});

app.get('/', (req, res) => {
  res.status(200).json({ message: 'Welcome to Clutch Arena API' });
});

module.exports = app;
