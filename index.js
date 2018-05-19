const http = require('http');
const axios = require('axios');
const fs = require('fs-extra');
const request = require('request');
const bbPromise = require('bluebird');
const requestPromise = require('request-promise-native');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const writeFilePromise = util.promisify(fs.writeFile);
const dicom = require('dicom-parser/dist/dicomParser');
const aiMktApi = require('@nuance/ai-marketplace-api');
require('dotenv').load();

const imageRootDir = process.env.IMAGE_ROOT_DIR;
const serviceId = process.env.AI_SERVICE_ID;
const serviceKey = process.env.SERVICE_KEY;
const hostname = '0.0.0.0';
const port = 3000;
const preProcessCmd = process.env.EXTERNAL_PREPROCESS_CMD;
const preProcessDir = process.env.PRE_PROCESS_OUTPUT_DIR;
const modelOutputDir = process.env.MODEL_OUTPUT_DIR;
const postProcessDir = process.env.POST_PROCESS_OUTPUT_DIR;
const postProcessCmd = process.env.EXTERNAL_POSTPROCESS_CMD;
// const modelEndpoint = 'http://127.0.0.1:8000/score/?';
const modelEndpoint = process.env.MODEL_ENDPOINT;
const aiTransactions = new aiMktApi(process.env.AI_TRANSACTIONS_ENDPOINT, 
  process.env.AI_TRANSACTIONS_KEY)
  
http.createServer((req, res) => {
    console.log(`\n${req.method} ${req.url}`);
    console.log(req.headers);
    let body = [];
    req
      .on('data', chunk => {
        body.push(chunk);
      })
      .on('end', () => {
        body = Buffer.concat(body).toString();
        if (req.url === '/') {
          console.log('Received complete request from AI Job Dispatcher'); 
          handleAIMarketplaceRequest(body);
        } else if (req.url === '/dicomInitiated') {
          handleDicomInitiatedRequest(body);
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Acknowledged\n');
      });
  })
  .listen(port, hostname, () => {
    console.log(`Server running at http://localhost:${port}/`);
  });

const handleDicomInitiatedRequest = async reqBody => {
  try {
    const { studyUID, studyFolder } = JSON.parse(reqBody);
    // pre-process 
    fs.ensureDirSync(`${preProcessDir}/${studyUID}`);
    await exec(`${preProcessCmd} ${studyFolder} ${preProcessDir}/${studyUID}`);
    // process all files through model, returns array of results
    const result = await runModel_type_1(`${preProcessDir}/${studyUID}`);
    fs.ensureDirSync(`${modelOutputDir}/${studyUID}`);
    await writeFilePromise(`${modelOutputDir}/${studyUID}/result.csv`, result.join(), 'utf8');
    // post-process results
    fs.ensureDirSync(`${postProcessDir}/${studyUID}`);
    await exec(`${postProcessCmd} ${modelOutputDir}/${studyUID}/result.csv` `${postProcessDir}/${studyUID}`);
    const transactionId = await aiTransactions.createTransaction(serviceId, studyUID, '0000000');
    const resultId = await aiTransactions.createResult(transactionId, serviceKey, 'test');
    await aiTransactions.uploadResultFiles(transactionId, resultId, [`${postProcessDir}/${studyUID}/post_output.json`]);
  } catch (err) {
    console.error(err);
  }
}

const handleAIMarketplaceRequest = async reqBody => {
  try {
    const { transactionId, uris } = JSON.parse(reqBody);
    let studyFolder, studyUid, imageUid;
    console.log(`Downloading ${uris.length} images for study`); 
    await bbPromise.map(uris, async url => {
        try {
          const result = await axios.get(url, {
            responseType: 'arraybuffer'
          });
          ({ studyUid, imageUid } = getUids(result.data));
          studyFolder = `${imageRootDir}/${studyUid}`;
          const outputFilename = `${imageRootDir}/${studyUid}/${imageUid}.dcm`;
          fs.ensureDirSync(studyFolder);
          fs.writeFileSync(outputFilename, result.data);
        } catch (err) {
          console.error(err);
        }
      }, { concurrency: 20 }
    );    
  
    console.log('All images for study downloaded');
    fs.ensureDirSync(`${preProcessDir}/${studyUid}`);
    await exec(`${preProcessCmd} ${studyFolder} ${preProcessDir}/${studyUid}`);
    console.log('Preprocessing of images for study complete');
    const result = await runModel_type_2(`${preProcessDir}/${studyUid}`);
    console.log('Model evaluation for all images complete');
    fs.ensureDirSync(`${postProcessDir}/${studyUid}`);
    await exec(`${postProcessCmd} ${modelOutputDir}/${studyUid} ${postProcessDir}/${studyUid}`);
    console.log('Post processing of model results complete');
    const fileList = fs.readdirSync(`${postProcessDir}/${studyUid}`).map(name => `${postProcessDir}/${studyUid}/${name}`);
    const resultId = await aiTransactions.createResult(transactionId, 'OSU-2017', 'OSU-2017', 'FROM_AI_SERVICE' );
    await aiTransactions.uploadResultFiles(transactionId, resultId, fileList);
    await aiTransactions.updateTransaction(transactionId, { status: 'ANALYSIS_COMPLETE' })
    console.log(`AI analysis results successfully uplaoded to API for transaction ${transactionId}.`);
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

// Model invokation type 1 is a GET request with a file directory path 
// passed in as a URL parameter
const runModel_type_1 = async directory => {
  const fileList = fs.readdirSync(directory);
  return await Promise.all(
    fileList.map(file => {
      const url = `${modelEndpoint}file=${directory + '/' + file}`;
      console.log(url);
      return axios.get(url);
    })
  );
};

// Model invokation type 2 is a POST request with multi-part form data
// passing the image file itself in the request
const runModel_type_2 = async directory => {
  const studyUid = directory.split('/').slice(-1);
  const fileList = fs.readdirSync(directory);
  const results = await Promise.all(
    fileList.map(file => {
      const formData = {
        image: fs.createReadStream(directory + '/' + file)
      }  
      return requestPromise.post({ url: modelEndpoint, formData})
    })
  );
  fs.ensureDirSync(`${modelOutputDir}/${studyUid}`);
  resultStr = results.reduce((acc, val) => acc + val + '\n', '');
  fs.writeFileSync(`${modelOutputDir}/${studyUid}/model_output.txt`, resultStr);
  return resultStr;
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
