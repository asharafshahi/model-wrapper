const http = require('http');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs-extra');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const dicom = require('dicom-parser/dist/dicomParser');
require('dotenv').load();

const imageRootDir = process.env.IMAGE_ROOT_DIR;
const AiMktPlaceAPI = process.env.AI_TRANSACTIONS_ENDPOINT;
const serviceKey = process.env.SERVICE_KEY;
const hostname = '0.0.0.0';
const port = 3000;
const modelEndpoint = 'http://127.0.0.1:8000/score/?file=';

const server = http
  .createServer((req, res) => {
    console.log(`\n${req.method} ${req.url}`);
    console.log(req.headers);
    let body = [];
    req
      .on('data', chunk => {
        body.push(chunk);
      })
      .on('end', async () => {
        body = Buffer.concat(body).toString();
        const { transactionId, uris } = JSON.parse(body);
        let studyFolder;
        await Promise.all(
          uris.map(async url => {
            try {
              const result = await axios.get(url, {
                responseType: 'arraybuffer'
              });
              const { studyUid, imageUid } = getUids(result.data);
              studyFolder = `${imageRootDir}/${studyUid}`;
              const outputFilename = `${imageRootDir}/${studyUid}/${imageUid}.dcm`;
              fs.ensureDirSync(studyFolder);
              fs.writeFileSync(outputFilename, result.data);
              console.log(`Wrote file ${outputFilename}`);
              await preProcessToPng(studyFolder);
            } catch (err) {
              console.error(err);
            }
          })
        );
        const result = await runModel(studyFolder + '/preprocess');
        console.log(`AI model returned: ${result[0].data}`);
        const postProcessedData = postProcessToJson(result);
        await postToAIMarketplace(transactionId, postProcessedData);
      });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Acknowledged\n');
  })
  .listen(port, hostname, () => {
    console.log(`Server running at http://localhost:${port}/`);
  });

const getUids = dicomData => {
  const dataSet = dicom.parseDicom(dicomData);
  const studyUid = dataSet.string('x0020000d');
  const imageUid = dataSet.string('x00080018');
  return { studyUid, imageUid };
};

// This function will be customized/replaced for each model based on needs
const preProcessToPng = async directory => {
  const fileList = fs.readdirSync(directory);
  fs.ensureDirSync(directory + '/preprocess');
  await Promise.all(
    fileList.map(file =>
      exec(
        `gdcm2vtk ${directory + '/' + file} ${directory +
          '/preprocess/' +
          file.substr(0, file.length - 4) +
          '.png'}`
      )
    )
  );
  return;
};

const runModel = async directory => {
  const fileList = fs.readdirSync(directory);
  return await Promise.all(
    fileList.map(file => {
      const url = `${modelEndpoint}${directory + '/' + file}`;
      console.log(url);
      return axios.get(url);
    })
  );
};

// This function will be customized/replaced for each model based on needs
const postProcessToJson = allResults =>
  JSON.stringify(
    allResults.reduce(
      (acc, curr) => {
        acc.findings.push(curr.data);
        return acc;
      },
      { findings: [] }
    )
  );

// This function may need to be customized if more than just JSON results are returned
const postToAIMarketplace = async (transactionId, data) => {
  let url = `${AiMktPlaceAPI}/${transactionId}/results`;
  const body = {
    serviceKey,
    resultKey: 'test'
  };
  const response = await axios.post(url, body);
  const resultId = response.data.result.id;
  url = `${url}/${resultId}/documents`;
  const config = {
    headers: {
      'content-type': 'multipart/form-data'
    }
  };
  fs.writeFileSync('result.json', data, 'utf8');
  form = new FormData();
  form.append('documentType', 'json');
  form.append('name', 'AI result');
  form.append('file', fs.createReadStream('result.json'));
  console.log(url);
  form.submit(url, (err, res) => {
    if (!err) console.log('submission success');
    fs.unlinkSync('result.json');
  });
};
