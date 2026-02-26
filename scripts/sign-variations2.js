const crypto=require('crypto');
const axios=require('axios');
const partnerId='1221766';
const api_path='/api/v2/shop/auth_partner';
const timestamp=Math.floor(Date.now()/1000).toString();
const redirect='https://abf1-179-193-9-250.ngrok-free.app/marketplace/shopee/callback';
const encoded=encodeURIComponent(redirect);
const key='shpk54695a7a437a436f456f7368515348726f5a5244614f554c61536251475a';
function hmac(str){return crypto.createHmac('sha256',key).update(str).digest('hex');}
const combos=[
  partnerId+redirect+timestamp,
  partnerId+timestamp+redirect,
  redirect+partnerId+timestamp,
  timestamp+partnerId+redirect,
  partnerId+api_path+redirect+timestamp,
];
(async()=>{
  for(const base of combos){
    const sig=hmac(base);
    const url=`https://partner.test-stable.shopeemobile.com${api_path}?partner_id=${partnerId}&redirect=${encoded}&timestamp=${timestamp}&sign=${sig}`;
    const r=await axios.get(url,{validateStatus:false});
    console.log('base',base,'sig',sig,'status',r.status,'err',r.data.error);
  }
})();