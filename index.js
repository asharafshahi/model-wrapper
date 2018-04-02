const http = require('http');
const axios = require('axios');
const fs = require('fs-extra');
const dicom = require('dicom-parser/dist/dicomParser');

const hostname = '0.0.0.0';
const port = 3000;

const server = http.createServer((req, res) => {
  console.log(`\n${req.method} ${req.url}`);
  console.log(req.headers);

  req.on('data', function(chunk) {
    response = JSON.parse(chunk);
    //console.log("BODY: " + chunk);

    response.uris.map(url => {
      axios
        .get(url, {
          responseType: 'arraybuffer'
        })
        .then(result => {
          try {
            const { studyUid, imageUid } = getUids(result.data);
            const outputFilename = `./tmp/${studyUid}/${imageUid}.dcm`;
            fs.ensureDirSync(`./tmp/${studyUid}`);

            fs.writeFileSync(outputFilename, result.data);
            console.log(`Wrote file ${outputFilename}`);
          } catch (err) {
            console.error(err);
          }
        });
    });
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Acknowledged\n');
});

const getUids = dicomData => {
  const dataSet = dicom.parseDicom(dicomData);
  const studyUid = dataSet.string('x0020000d');
  const imageUid = dataSet.string('x00080018');
  return { studyUid, imageUid };
};

server.listen(port, hostname, () => {
  console.log(`Server running at http://localhost:${port}/`);
});
