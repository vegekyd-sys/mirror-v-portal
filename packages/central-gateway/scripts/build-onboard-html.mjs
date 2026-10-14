import {mkdir,writeFile} from 'node:fs/promises';
import {ONBOARD_HTML} from '../dist/services/onboard-page.js';
const directory=new URL('../public/onboard/',import.meta.url);
await mkdir(directory,{recursive:true});
await writeFile(new URL('index.html',directory),ONBOARD_HTML);
