export const CSI = "\x1b[";
export type ANSIColor = "black"|"red"|"green"|"yellow"|"blue"|"magenta"|"cyan"|"white"
  |"gray"|"brightRed"|"brightGreen"|"brightYellow"|"brightBlue"|"brightMagenta"|"brightCyan"|"brightWhite";
const FG: Record<ANSIColor,number> = { black:30,red:31,green:32,yellow:33,blue:34,magenta:35,cyan:36,white:37,gray:90,brightRed:91,brightGreen:92,brightYellow:93,brightBlue:94,brightMagenta:95,brightCyan:96,brightWhite:97 };
export function fg(c:ANSIColor):string{return CSI+FG[c]+"m";}
export function bold():string{return CSI+"1m";}
export function reset():string{return CSI+"0m";}
export interface StyleOpts { fg?:ANSIColor;bg?:ANSIColor;bold?:boolean;dim?:boolean;italic?:boolean;underline?:boolean; }
export function applyStyle(text:string,opts:StyleOpts):string{let c="";if(opts.fg)c+=fg(opts.fg);if(opts.bold)c+=bold();if(opts.dim)c+=dim();return c?c+text+reset():text;}
export function stripAnsi(s:string):string{return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g,"");}
export function cursorTo(x:number,y:number):string{return CSI+(y+1)+";"+(x+1)+"H";}
export function eraseScreen():string{return CSI+"2J";}
export function cursorShow():string{return CSI+"?25h";}
export function cursorHide():string{return CSI+"?25l";}