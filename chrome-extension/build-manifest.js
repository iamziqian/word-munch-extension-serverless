const fs = require('fs');
const path = require('path');

// Read the config.js file
const configPath = path.join(__dirname, 'config', 'config.js');
const configContent = fs.readFileSync(configPath, 'utf8');

// Extract API endpoint
const apiEndpointMatch = configContent.match(/WORD_API_ENDPOINT:\s*'([^']+)'/);
if (!apiEndpointMatch) {
    console.error('Could not find API endpoint in config.js');
    process.exit(1);
}

const apiEndpoint = apiEndpointMatch[1];
const baseUrl = apiEndpoint.replace('/dev/word-muncher', '');

// Read the original manifest template
const manifestTemplatePath = path.join(__dirname, 'manifest.template.json');
const manifestTemplate = JSON.parse(fs.readFileSync(manifestTemplatePath, 'utf8'));

// Replace host_permissions in the manifest template
manifestTemplate.host_permissions = [`${baseUrl}/*`];

// Write the generated manifest.json
const outputPath = path.join(__dirname, 'manifest.json');
fs.writeFileSync(outputPath, JSON.stringify(manifestTemplate, null, 2));

console.log(`Generated manifest.json with API endpoint: ${baseUrl}`); 