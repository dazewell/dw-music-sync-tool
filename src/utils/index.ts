export function logger(level: string, message: string) {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}]: ${message}`);
}
