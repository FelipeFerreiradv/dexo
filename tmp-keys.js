const axios=require('axios');const crypto=require('crypto');
const host='https://partner.test-stable.shopeemobile.com';
const partnerId=1222187;const apiPath='/api/v2/shop/auth_partner';const ts=Math.floor(Date.now()/1000);
const redirect='https://2dab-152-234-122-51.ngrok-free.app/marketplace/shopee/callback';
const keyFull='shpk70626b74774c7842676e664462536179534c7457534e6a664672534f6b61';
const keyNoPrefix=keyFull.replace(/^shpk/,'');
function hmacHex(key,base){return crypto.createHmac('sha256', key).update(base).digest('hex');}
function hmacHexBuf(key,base){return crypto.createHmac('sha256', Buffer.from(key,'hex')).update(base).digest('hex');}
const base=partnerId+apiPath+ts;
for (const [label,key] of [['full',keyFull],['noprefix',keyNoPrefix]]){
  console.log('---',label);
  const s1=hmacHex(key, base);
  const s2=hmacHexBuf(key, base);
  for (const [name,sign] of [['hmac',s1],['hmacBuf',s2]]){
    const url=host+apiPath+'?partner_id='+partnerId+'&timestamp='+ts+'&sign='+sign+'&redirect='+encodeURIComponent(redirect)+'&sign_method=sha256';
    axios.get(url,{validateStatus:()=>true}).then(r=>console.log(name,'status',r.status,'err',r.data?.error)).catch(e=>console.log(name,'err',e.message));
  }
}
