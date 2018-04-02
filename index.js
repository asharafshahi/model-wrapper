const http = require("http");
const axios = require("axios");
const fs = require("fs");

const hostname = "0.0.0.0";
const port = 3000;

const server = http.createServer((req, res) => {
  console.log(`\n${req.method} ${req.url}`);
  console.log(req.headers);

  req.on("data", function(chunk) {
    response = JSON.parse(chunk);
    //console.log("BODY: " + chunk);
  
    response.uris.map(url => {
      axios.get(url, {
        responseType: 'arraybuffer',
      })
      .then(result => {
	 const num = Math.floor((Math.random() * 1000) + 1);
         const outputFilename = `./file${num}.dcm`;
         fs.writeFileSync(outputFilename, result.data);
         console.log(`Wrote file ./file${num}.dcm`);
      });
    });
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain");
  res.end("Acknowledged\n");
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://localhost:${port}/`);
});
