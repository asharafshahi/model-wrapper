const http = require('http');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs-extra');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const writeFilePromise = util.promisify(fs.writeFile);
const dicom = require('dicom-parser/dist/dicomParser');
const aiMktApi = require('@nuance/ai-marketplace-api');
require('dotenv').load();

const imageRootDir = process.env.IMAGE_ROOT_DIR;
const AiMktPlaceAPI = process.env.AI_TRANSACTIONS_ENDPOINT;
const serviceId = process.env.AI_SERVICE_ID;
const serviceKey = process.env.SERVICE_KEY;
const hostname = '0.0.0.0';
const port = 3000;
const preProcessCmd = process.env.EXTERNAL_PREPROCESS_CMD;
const preProcessDir = process.env.PRE_PROCESS_OUTPUT_DIR;
const modelOutputDir = process.env.MODEL_OUTPUT_DIR;
const postProcessDir = process.env.POST_PROCESS_OUTPUT_DIR;
const postProcessCmd = process.env.EXTERNAL_POSTPROCESS_CMD;
const modelEndpoint = 'http://127.0.0.1:8000/score/?file=';
const aiTransactions = new aiMktApi(process.env.AI_TRANSACTIONS_ENDPOINT, 
  process.env.AI_TRANSACTIONS_KEY)
  
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
        if (req.url === '/') {
          handleAIMarketplaceRequest(body);
        } else if (req.url === '/dicomInitiated') {
          handleDicomInitiatedRequest(body);
        }
      });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Acknowledged\n');
  })
  .listen(port, hostname, () => {
    console.log(`Server running at http://localhost:${port}/`);
  });

const handleDicomInitiatedRequest = async reqBody => {
  try {
    const { studyUID, studyFolder } = JSON.parse(reqBody);
    // pre-process 
    await exec(`${preProcessCmd} studyFolder ${preProcessDir}/${studyUID}`);
    // process all files through model, returns array of results
    const result = await runModel(`${preProcessDir}/${studyUID}`);
    await writeFilePromise(`${modelOutputDir}/${studyUID}/result.csv`, result.join(), 'utf8');
    // post-process results
    await exec(`${postProcessCmd} ${modelOutputDir}/${studyUID}/result.csv` `${postProcessDir}/${studyUID}`);
    const transactionId = await aiTransactions.createTransaction(serviceId, studyUID, '0000000');
    await aiTransactions.uploadResult(transactionId, serviceKey, 'test', final)
  } catch (err) {
    console.error(err);
  }
}

const handleAIMarketplaceRequest = async reqBody => {
  try {
    const { transactionId, uris } = JSON.parse(reqBody);
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
    await aiTransactions.uploadResult(transactionId, serviceKey, 'test', postProcessedData);
  } catch (err) {
    console.error(err);
  }
}

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