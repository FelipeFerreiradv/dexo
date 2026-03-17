const axios=require('axios');
const crypto=require('crypto');
const host='https://partner.test-stable.shopeemobile.com';
const partnerId=1222187;
const apiPath='/api/v2/shop/auth_partner';
const ts=Math.floor(Date.now()/1000);
const redirect='https://2dab-152-234-122-51.ngrok-free.app/marketplace/shopee/callback';
const key='shpk70626b74774c7842676e664462536179534c7457534e6a664672534f6b61';
const bases=[
  partnerId+apiPath+ts,
  partnerId+apiPath+ts+redirect,
  partnerId+apiPath+ts+encodeURIComponent(redirect),
  partnerId+apiPath+ts+key,
  key+partnerId+apiPath+ts,
];
const methods={
  hmac:(base)=>crypto.createHmac('sha256', key).update(base).digest('hex'),
  hmacHex:(base)=>crypto.createHmac('sha256', Buffer.from(key,'hex')).update(base).digest('hex'),
  sha:(base)=>crypto.createHash('sha256').update(base).digest('hex'),
};
(async()=>{
  for (const base of bases){
    for (const [name,fn] of Object.entries(methods)){
      const sign=fn(base);
      const url=host+apiPath+'?partner_id='+partnerId+'&timestamp='+ts+'&sign='+sign+'&redirect='+encodeURIComponent(redirect)+'&sign_method=sha256';
      const res=await axios.get(url,{validateStatus:()=>true});
      console.log(name, 'baseLen', base.length, 'status', res.status, res.data?.error||res.statusText);
    }
  }
})();
