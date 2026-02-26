const crypto=require('crypto');
const shopUrlSignature='51fca0597dea290bf256b2'; // partial, use shorter due to log
const key='shpk63754d73717455534a7141455649414561517850664e6c4541415156634d';
const partnerId='1221766';
const api_path='/api/v2/shop/auth_partner';
const timestamp='1772119436';
const redirect='https://abf1-179-193-9-250.ngrok-free.app/marketplace/shopee/callback';
const encoded=encodeURIComponent(redirect);
const stripped=key.replace(/^shpk/,'');

function hmac(k,s){return crypto.createHmac('sha256',k).update(s).digest('hex');}
function sha(s){return crypto.createHash('sha256').update(s).digest('hex');}

const combos=[
  partnerId+api_path+timestamp,
  partnerId+api_path+timestamp+redirect,
  partnerId+api_path+timestamp+encoded,
  partnerId+api_path+encoded+timestamp,
  partnerId+timestamp+api_path,
];

console.log('using key full',key.length,'stripped',stripped.length);
combos.forEach(c=>{
  console.log('base',c);
  console.log('hmac-full',hmac(key,c));
  console.log('hmac-stripped',hmac(stripped,c));
  console.log('sha',sha(c+key));
});
