const crypto=require('crypto');
function hmac(k,s){return crypto.createHmac('sha256',k).update(s).digest('hex');}
const key='shpk63754d73717455534a7141455649414561517850664e6c4541415156634d';
const partnerId='1221766';
const api_path='/api/v2/shop/auth_partner';
const full_url='https://partner.test-stable.shopeemobile.com'+api_path;
const ts='1772119680';
const redirect='https://abf1-179-193-9-250.ngrok-free.app/marketplace/shopee/callback';
const encoded=encodeURIComponent(redirect);
const combos=[
  partnerId+api_path+ts+redirect,
  partnerId+full_url+ts+redirect,
  partnerId+api_path+redirect+ts,
  partnerId+full_url+redirect+ts
];
combos.forEach(c=>console.log('base',c,'sig',hmac(key,c)));
