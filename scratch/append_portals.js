const fs = require('fs');

const raw = fs.readFileSync('scratch/companies.txt', 'utf8');
const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
const uniqueCompanies = [...new Set(lines)];

let yaml = '\n';

for (const company of uniqueCompanies) {
  yaml += `  - name: "${company.replace(/"/g, '\\"')}"\n`;
  yaml += `    careers_url: "https://www.google.com/search?q=${encodeURIComponent(company)}+careers"\n`; 
  yaml += `    scan_method: websearch\n`;
  yaml += `    scan_query: '"${company.replace(/"/g, '\\"')}" "AI" OR "Data" OR "Machine Learning" Germany OR remote'\n`;
  yaml += `    enabled: true\n\n`;
}

fs.appendFileSync('portals.yml', yaml);
console.log(`Appended ${uniqueCompanies.length} companies to portals.yml`);
