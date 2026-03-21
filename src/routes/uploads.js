const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});

const ALLOWED = [
  'image/jpeg','image/png','image/gif','image/webp',
  'application/pdf','text/plain','application/json','application/zip',
  'audio/webm','audio/ogg','audio/wav','audio/mp4','audio/mpeg','audio/webm;codecs=opus',
];

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mimeBase = file.mimetype.split(';')[0].trim();
    if (ALLOWED.includes(file.mimetype) || ALLOWED.includes(mimeBase) || mimeBase.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`));
    }
  },
});

router.post('/', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const { messageId } = req.body;
  const url = `${process.env.BACKEND_URL || 'https://nexus-chat-bxfz.onrender.com'}/uploads/${req.file.filename}`;

  if (messageId) {
    await query(
      `INSERT INTO attachments (message_id, filename, mime_type, size_bytes, s3_key, url)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [messageId, req.file.originalname, req.file.mimetype, req.file.size, url, url]
    );
  }

  res.status(201).json({
    ok: true,
    file: {
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      url,
    },
  });
}));

module.exports = router;