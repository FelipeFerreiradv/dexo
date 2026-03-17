const axios=require('axios');const crypto=require('crypto');
const host='https://partner.test-stable.shopeemobile.com';
const partnerId=1222187;const apiPath='/api/v2/shop/auth_partner';const ts=Math.floor(Date.now()/1000);
const redirect='https://2dab-152-234-122-51.ngrok-free.app';
const key='shpk70626b74774c7842676e664462536179534c7457534e6a664672534f6b61';
const base=`${partnerId}${apiPath}${ts}`;
const sign=crypto.createHmac('sha256', key).update(base).digest('hex');
const url=`${host}${apiPath}?partner_id=${partnerId}&timestamp=${ts}&sign=${sign}&redirect=${encodeURIComponent(redirect)}&sign_method=sha256`;
axios.get(url,{validateStatus:()=>true}).then(r=>console.log('status',r.status,'err',r.data?.error||r.statusText)).catch(e=>console.log('err',e.message));
