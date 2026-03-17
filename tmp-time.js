const https=require("https");
const options={method:"HEAD",host:"partner.test-stable.shopeemobile.com",path:"/"};
const req=https.request(options,(res)=>{console.log('status',res.statusCode);console.log('date header',res.headers.date);
console.log('local epoch',Date.now());console.log('local sec',Math.floor(Date.now()/1000));
const serverDate=new Date(res.headers.date);
console.log('server epoch',serverDate.getTime());console.log('diff_ms',Date.now()-serverDate.getTime());
});
req.on('error',console.error);
req.end();
