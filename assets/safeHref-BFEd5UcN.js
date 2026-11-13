function n(r){if(!r)return null;try{const t=new URL(String(r).trim());return t.protocol==="https:"||t.protocol==="http:"?t.toString():null}catch{return null}}export{n as w};
