const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ALLOWED = [
  'image/jpeg','image/png','image/gif','image/webp',
  'application/pdf','text/plain','application/json','application/zip',
  'audio/webm','audio/ogg','audio/wav','audio/mp4','audio/mpeg','audio/webm;codecs=opus',
];

const upload = multer({
  storage: multer.memoryStorage(),
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
  const ext = path.extname(req.file.originalname);
  const filename = `${uuidv4()}${ext}`;

  // Upload to Supabase Storage
  const { data, error } = await supabase.storage
    .from('uploads')
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

  if (error) {
    console.error('Supabase upload error:', error);
    return res.status(500).json({ error: 'File upload failed' });
  }

  // Get public URL
  const { data: { publicUrl } } = supabase.storage
    .from('uploads')
    .getPublicUrl(filename);

  if (messageId) {
    await query(
      `INSERT INTO attachments (message_id, filename, mime_type, size_bytes, s3_key, url)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [messageId, req.file.originalname, req.file.mimetype, req.file.size, filename, publicUrl]
    );
  }

  res.status(201).json({
    ok: true,
    file: {
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      url: publicUrl,
    },
  });
}));

module.exports = router;