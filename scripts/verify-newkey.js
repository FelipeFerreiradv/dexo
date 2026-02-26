const crypto=require('crypto');
const key='shpk54695a7a437a436f456f7368515348726f5a5244614f554c61536251475a';
const partner='1221766';
const api='/api/v2/shop/auth_partner';
const ts='1772120004494';
const redirect='https://abf1-179-193-9-250.ngrok-free.app/marketplace/shopee/callback';
console.log('sig',crypto.createHmac('sha256',key).update(partner+api+ts+redirect).digest('hex'));