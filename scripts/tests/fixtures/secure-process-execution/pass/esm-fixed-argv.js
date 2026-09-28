import { execFileSync as runTool } from 'node:child_process';

const userPath = process.env.USER_PATH;
runTool(
  'C:\\Program Files\\Contoso\\tool.exe',
  ['/tmp/site with spaces', 'C:\\sites\\demo & literal', userPath],
  { shell: false }
);
