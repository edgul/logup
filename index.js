const { google } = require('googleapis');
const express = require('express');
const stream = require('stream');
const multer = require('multer');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Path to your service account key file
const GCLOUD_KEYFILEPATH = 'key.json'; // gCloud credentials
const DRIVE_ID = process.env.MOZ_LOGUP_DRIVE_ID; // put your team's gDrive ID in this system env variable
const BUGZILLA_API_KEY = process.env.MOZ_LOGUP_BUGZILLA_API_KEY; // put your bot's API key in this system env variable

// Read credentials from the key file
// no-file and empty file errors will fail here
const credentials = JSON.parse(fs.readFileSync(GCLOUD_KEYFILEPATH, 'utf8'));

// very basic checks for valid config (empty env var detection)
if (!DRIVE_ID) {
  console.log("Config failure: No drive id for file submission");
  return;
}
if (!BUGZILLA_API_KEY) {
  console.log("Config failure: No bugzilla API key for notification");
  return;
}

// todo:
// * check big upload, watch memory
// * security review and associated fixes
// * SRE setup
// * (nice to have) sometimes a deleted folder (not fully deleted) is found and used as drop location

// Initialize the auth client
const auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/drive.file'
    ]
});
const drive = google.drive({ version: 'v3', auth });

// returns the id of the folder if it exists on the team's gDrive
async function getFolderId(name) {
  const response = await drive.files.list({
      //pageSize: 10, // Number of files to list
      driveId: DRIVE_ID, // Replace with your shared drive ID
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'drive', // This ensures the listing is specific to the shared drive
      q: `mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id, name)',
  });

  const files = response.data.files;
  console.log("Folder count: " + files.length);
  if (files.length) {
    for (let file of files) {
      // console.log(`${file.name} (${file.id})`);
      if (file.name == name) {
        return file.id; 
      }
    }
  } 
  console.log('No folder by that name.');
  return "";
}

// creates a folder on the team's gDrive
async function createFolder(name) {
  // no need to create folder if it already exists
  let folderId = await getFolderId(name);
  if (folderId != "") {
    console.log(`Folder already exists: ${name}`);
    return folderId; 
  }
  
  console.log(`Creating folder: ${name}`);
  const folderMetadata = {
      name: name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [DRIVE_ID]
  };
  const folder = await drive.files.create({
    supportsTeamDrives: true,
      driveId: DRIVE_ID, // Replace with your shared drive ID
      resource: folderMetadata,
      fields: 'id'
  });
  return folder.data.id;
}

// creates a comment on the associated bugzilla bug
async function createBugzillaComment(bugId) {
  const url = `https://bugzilla.mozilla.org/rest/bug/${bugId}/comment`;
  const data = {
    "comment": "A log has been successfully uploaded to the team's storage",
  };
  const headers = {
    'X-BUGZILLA-API-KEY': BUGZILLA_API_KEY
  };

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(data),
  }).then(response => {
    return response.status == 201;
  }).catch(error => {
    console.error('Error:', error);
    return false;
  });
}

// Serve the HTML file for uploads
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/upload.html');
});

async function checkBugIdExists(bugId) {
  const url = `https://bugzilla.mozilla.org/rest/bug/${bugId}`;
  const headers = {
    'X-BUGZILLA-API-KEY': BUGZILLA_API_KEY
  };
  return fetch(url, { headers }).then(response => {
    if (!response.ok) {
      return { error: true, message: "Bug number does not appear to exist" }
    }
    return { error: false };
  }).catch(() => {
    return { error: true, message: "Unknown"}
  });
}

// Endpoint to handle file uploads
app.post('/upload', upload.single('file'), async (req, res) => {
  if (req.file) {
      try {
        // check that bugzilla bug exists
        let maybeError = await checkBugIdExists(req.body.bugid);
        if (maybeError.error) {
          let errString = 'Failed to upload file: '.concat(maybeError.message);
          console.log(errString);
          res.send(errString);
          return;
        }

        // create the gDrive folder (if needed) for our bug
        let folder = await createFolder(`${req.body.bugid}`);
        const bufferStream = new stream.PassThrough();
        bufferStream.end(Buffer.from(req.file.buffer));

        // upload the file to the new folder
        let media = {
            mimeType: req.file.mimetype,
            body: bufferStream
        }
        const fileMetadata = {
            name: req.file.originalname,
            parents: [folder]
        };
        await drive.files.create({
          supportsTeamDrives: true,
            driveId: DRIVE_ID, // Replace with your shared drive ID
            resource: fileMetadata,
            fields: 'id',
            media: media
        });
        let userFeedback = `File uploaded successfully.\n<br>`;

        // update bugzilla with comment
        if (await createBugzillaComment(req.body.bugid)){
          userFeedback = userFeedback.concat("Added comment to bugzilla");
        } else {
          userFeedback = userFeedback.concat("Failed to comment to bugzilla");
        }
        console.log(userFeedback);
        res.send(userFeedback);
      } catch (error) {
        console.error('Error uploading file:', error);
        res.status(500).send('Error uploading file');
      }
  } else {
      res.status(400).send('No file uploaded');
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// unused
// async function createFile(filename, folder) {
//     const fileMetadata = {
//         name: filename,
//         parents: [folder]
//     };
//     const file = await drive.files.create({
//       supportsTeamDrives: true,
//         driveId: DRIVE_ID, // Replace with your shared drive ID
//         resource: fileMetadata,
//         fields: 'id'
//     });
//     console.log('File ID: ', file.data.id);
// }
//
// async function listFiles() {
//     try {
//         const response = await drive.files.list({
//             // pageSize: 10, // Number of files to list
//             fields: 'nextPageToken, files(id, name)',
//             driveId: DRIVE_ID, // Replace with your shared drive ID
//             includeItemsFromAllDrives: true,
//             supportsAllDrives: true,
//             corpora: 'drive' // This ensures the listing is specific to the shared drive
//         });

//         const files = response.data.files;
//         if (files.length) {
//             console.log('Files:');
//             files.forEach(file => {
//                 console.log(`${file.name} (${file.id})`);
//             });
//         } else {
//             console.log('No files found.');
//         }
//     } catch (error) {
//         console.error('The API returned an error: ', error);
//     }
// }
