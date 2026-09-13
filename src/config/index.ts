import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  soundiizApiKey: z.string().default(''),
  soundiizApiUrl: z.string().default('https://api.soundiiz.com/v1'),
  backupDir: z.string().default('./backups'),
  port: z.coerce.number().default(3000),
  logLevel: z.string().default('info'),
});

export const config = configSchema.parse({
  soundiizApiKey: process.env.SOUNDIIZ_API_KEY,
  soundiizApiUrl: process.env.SOUNDIIZ_API_URL,
  backupDir: process.env.BACKUP_DIR,
  port: process.env.PORT,
  logLevel: process.env.LOG_LEVEL,
});

export type Config = z.infer<typeof configSchema>;
