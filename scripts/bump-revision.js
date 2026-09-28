const fs=require('fs');
const path=require('path');
function bump(root=path.resolve(__dirname,'..')){
  const packagePath=path.join(root,'package.json');
  const pkg=JSON.parse(fs.readFileSync(packagePath,'utf8'));
  const parts=String(pkg.version||'1.7.0').split('.').map(Number);
  if(parts.some(n=>!Number.isInteger(n)||n<0)) throw new Error(`Ugyldig versjon: ${pkg.version}`);
  parts[1]+=1;parts[2]=0;
  pkg.version=parts.join('.');pkg.appRevision=parts[1];
  fs.writeFileSync(packagePath,JSON.stringify(pkg,null,2)+'\n');
  const revision=`STABLE ${parts[0]}.${parts[1]}`;
  const indexPath=path.join(root,'public','index.html');
  let index=fs.readFileSync(indexPath,'utf8');
  index=index.replace(/(id="revisionBadge">)STABLE \d+\.\d+/,`$1${revision}`);
  fs.writeFileSync(indexPath,index);
  return {version:pkg.version,revision};
}
if(require.main===module)process.stdout.write(bump().revision+'\n');
module.exports={bump};
