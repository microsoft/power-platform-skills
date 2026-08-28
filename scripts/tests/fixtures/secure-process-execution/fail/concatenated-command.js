import { exec as run } from 'child_process';

run('pac pages upload --path ' + process.argv[2]);
