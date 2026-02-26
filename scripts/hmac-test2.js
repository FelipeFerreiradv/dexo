const crypto=require('crypto');
const raw='shpk63754d73717455534a7141455649414561517850664e6c4541415156634d';
const key=raw.replace(/^shpk/,'');
const partnerId='1221766';
const api='/api/v2/shop/auth_partner';
const timestamp='1772118912563';
console.log('keylen',key.length);
const h=crypto.createHmac('sha256',key).update(partnerId+api+timestamp).digest('hex');
console.log('hmac',h);
