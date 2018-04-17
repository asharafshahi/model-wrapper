const http = require('http');
const axios = require('axios');
const fs = require('fs-extra');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const dicom = require('dicom-parser/dist/dicomParser');
require('dotenv').load();

const imageRootDir = process.env.IMAGE_ROOT_DIR;
const hostname = '0.0.0.0';
const port = 3000;

const server = http
  .createServer((req, res) => {
    console.log(`\n${req.method} ${req.url}`);
    console.log(req.headers);
    let body = [];
    req
      .on('error', err => {
        console.error(err);
        res.statusCode = 400;
        response.end();
      })
      .on('data', chunk => {
        body.push(chunk);
      })
      .on('end', () => {
        body = Buffer.concat(body).toString();
        response = JSON.parse(body);
        let studyFolder;
        await Promise.all(response.uris.map(url =>
          axios
            .get(url, {
              responseType: 'arraybuffer'
            })
            .then(result => {
              try {
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
            .catch(err => {
              console.error(err.message);
            });
        ));
        await runModel(studyFolder + '/preprocess');

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

const preProcessToPng = async (directory) => {
  const fileList = fs.readdirSync(directory);
  await Promise.all(fileList.map(file =>
    exec(`gdcm2vtk ${directory + '/' + file} ${directory + '/preprocess/' +
          file.split('.')[0] + '.png'}`)
  ));
  return;
}

const runModel = async (directory) => {
  const fileList = fs.readdirSync(directory);
  await Promise.all(fileList.map(file =>
    exec(`${modelCommand} ${directory + '/' + file}`)
  ));
  return;
}
