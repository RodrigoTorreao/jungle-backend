import { createApp } from './bootstrap';
import { InvalidConfigError, loadConfig } from './infrastructure/config/app-config';

try {
  const config = loadConfig(process.env);
  const app = await createApp(config);
  await app.listen(config.port);
} catch (error) {
  if (error instanceof InvalidConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
