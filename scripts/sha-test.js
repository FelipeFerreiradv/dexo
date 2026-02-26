const crypto=require('crypto');
const key='shpk63754d73717455534a7141455649414561517850664e6c4541415156634d';
const partnerId='1221766';
const api='/api/v2/shop/auth_partner';
const timestamp='1772118912563';
const base=partnerId+api+timestamp+key;
console.log('sha',crypto.createHash('sha256').update(base).digest('hex'));
