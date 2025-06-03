import * as XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';

interface ZipInfo {
  zip: string;
  city: string;
  state_id: string;
  state_name: string;
  county_name: string;
  county_fips: string;
}

let zipData: Map<string, ZipInfo> | null = null;

export async function initializeZipData() {
  if (zipData) return; // Already initialized

  try {
    const filePath = path.join(process.cwd(), 'app', 'data', 'uszips.xlsx');
    const buffer = fs.readFileSync(filePath);
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    zipData = new Map();
    
    data.forEach((row: any) => {
      // Debug log to see the raw data
      console.log('Processing row:', row);
      
      // Check if zip is a number and convert to string with padding
      const zip = typeof row.zip === 'number' 
        ? row.zip.toString().padStart(5, '0') 
        : row.zip?.toString() || '';

      if (zip && row.county_name && row.state_id) {
        zipData!.set(zip, {
          zip: zip,
          city: row.city || '',
          state_id: row.state_id,
          state_name: row.state_name || '',
          county_name: row.county_name,
          county_fips: row.county_fips?.toString() || ''
        });
      }
    });

    console.log('Available ZIP codes:', Array.from(zipData.keys()));
    console.log(`Loaded ${zipData.size} ZIP codes`);
  } catch (error) {
    console.error('Error loading ZIP data:', error);
    throw new Error('Failed to load ZIP code database');
  }
}

export function lookupZip(zipcode: string): ZipInfo | null {
  if (!zipData) {
    throw new Error('ZIP database not initialized');
  }
  // Debug log for lookup attempts
  console.log('Looking up ZIP:', zipcode);
  console.log('Available ZIPs:', Array.from(zipData.keys()));
  
  const result = zipData.get(zipcode);
  console.log('Lookup result:', result);
  return result || null;
} 