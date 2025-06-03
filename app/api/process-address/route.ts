import { NextResponse } from 'next/server';
import { tavily } from '@tavily/core';
import { initializeZipData, lookupZip } from '@/app/utils/zipLookup';
import OpenAI from 'openai';

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content: string | null;
}

interface TavilyResponse {
  query: string;
  results: TavilySearchResult[];
  responseTime: number;
  images: any[];
  answer: string | null;
}

interface TavilyExtractResult {
  url: string;
  raw_content: string;
  content?: string;
  images?: string[];
  status_code?: number;
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failed_results: Array<{ url: string; error: string }>;
  response_time: number;
}

if (!process.env.TAVILY_API_KEY) {
  throw new Error('TAVILY_API_KEY is not set in environment variables');
}

if (!process.env.GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN is not set in environment variables');
}

const client = tavily({ apiKey: process.env.TAVILY_API_KEY });
const aiClient = new OpenAI({ 
  baseURL: "https://models.github.ai/inference",
  apiKey: process.env.GITHUB_TOKEN 
});

// Helper function to extract zipcode using regex
function extractZipcode(address: string): string | null {
  const zipcodeRegex = /\b\d{5}(?:-\d{4})?\b/;
  const match = address.match(zipcodeRegex);
  return match ? match[0] : null;
}

// Helper function to find parcel URL for a given address in raw content
function findParcelUrl(searchAddress: string, rawContent: string): string | null {
  // Normalize the search address by removing extra spaces and converting to lowercase
  const normalizedSearchAddress = searchAddress.toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+rd$/i, ' road')  // Normalize RD to ROAD
    .replace(/,.*$/, '')  // Remove everything after comma (including ZIP)
    .trim();
  
  // Create variations of the address (with and without spaces)
  const addressVariations = [
    normalizedSearchAddress,
    normalizedSearchAddress.replace(/\s/g, '+'),  // Replace spaces with +
    normalizedSearchAddress.replace(/\s/g, '%20'), // Replace spaces with %20
    normalizedSearchAddress.replace(/\s+road$/i, ' rd'), // Handle ROAD vs RD
    normalizedSearchAddress.replace(/\s+rd$/i, ' road') // Handle RD vs ROAD
  ];

  // Look for links that contain both the address and parcel.aspx
  const linkRegex = /\[([^\]]+)\]\(([^)]+parcel\.aspx[^)]+)\)/gi;
  let match;

  while ((match = linkRegex.exec(rawContent)) !== null) {
    const linkText = match[1].toLowerCase();
    const linkUrl = match[2];
    
    // Check if any variation of our address matches the link text
    if (addressVariations.some(variation => linkText === variation)) {
      return linkUrl;
    }
  }

  // If no exact match found, try matching just the number and street
  const addressParts = normalizedSearchAddress.match(/^(\d+)\s+([^,]+?)(?:\s+(?:road|rd))?$/i);
  if (addressParts) {
    const [_, houseNumber, streetName] = addressParts;
    const simpleMatch = new RegExp(`\\[${houseNumber}\\s+${streetName}[^\\]]*\\]\\(([^)]+parcel\\.aspx[^)]+)\\)`, 'i');
    match = rawContent.match(simpleMatch);
    if (match) {
      return match[1];
    }
  }

  return null;
}

// Helper function to remove zipcode from address
function removeZipcode(address: string): string {
  return address.replace(/,?\s*\b\d{5}(?:-\d{4})?\b/, '').trim();
}

// Initialize ZIP data when the API route module loads
initializeZipData().catch(console.error);

export async function POST(request: Request) {
  try {
    const { address } = await request.json();
    console.log('\n=== Starting Address Processing ===');
    console.log('Input address:', address);

    // Step 1: Extract zipcode using regex
    const zipcode = extractZipcode(address);
    console.log('\n=== Zipcode Extraction ===');
    console.log('Extracted zipcode:', zipcode);
    
    if (!zipcode) {
      return NextResponse.json({ error: 'Could not extract zipcode from address' }, { status: 400 });
    }

    // Remove zipcode from address for search
    const searchAddress = removeZipcode(address);
    console.log('Search address (without ZIP):', searchAddress);

    // Step 2: Get county/state information from ZIP database
    const locationInfo = lookupZip(zipcode);
    console.log('\n=== Location Information ===');
    console.log('Location info:', JSON.stringify(locationInfo, null, 2));
    
    if (!locationInfo) {
      return NextResponse.json({ error: 'County information not found for this zipcode' }, { status: 404 });
    }

    // Step 3: Construct search URL based on city info
    const searchUrl = `https://gis.vgsi.com/${locationInfo.city.toLowerCase().replace(/\s+/g, '')}${locationInfo.state_id.toLowerCase()}/search.aspx`;
    console.log('\n=== Search URL ===');
    console.log('Constructed search URL:', searchUrl);

    // Step 4: Use Tavily to search
    console.log('\n=== Starting Tavily Search ===');
    const searchResults = await client.search(
      `${searchAddress} property sale history transactions`,
      {
        includeRawContent: true,
        includeDomains: ["https://gis.vgsi.com/"]
      }
    );
    console.log('Tavily search completed');
    console.log('Raw Tavily search results:', JSON.stringify(searchResults, null, 2));

    // Get the result with highest score
    const bestMatch = searchResults.results
      .sort((a, b) => b.score - a.score)[0];

    if (!bestMatch) {
      return NextResponse.json({ 
        error: 'No property records found for this address' 
      }, { status: 404 });
    }

    console.log('\n=== Best Matching Result ===');
    console.log('Best matching result:', JSON.stringify(bestMatch, null, 2));

    // Check if the search address appears in any of the results
    const addressMatches = searchResults.results.filter(result => {
      const normalizedContent = result.content.toLowerCase();
      const normalizedAddress = searchAddress.toLowerCase();
      return normalizedContent.includes(normalizedAddress);
    });

    // Use the best matching result that contains the address, or fall back to the highest scored result
    const resultToUse = addressMatches.length > 0 ? addressMatches[0] : bestMatch;
    const resultUrl = resultToUse.url;
    console.log('\n=== Result URL ===');
    console.log('Using result URL:', resultUrl);

    // Step 5: Use GitHub AI model with OpenAI client
    console.log('\n=== Starting AI Model Request ===');
    try {
      // Send the extracted data to OpenAI for processing
      const prompt = `Extract property sale transactions from the following real estate data. Return ONLY the transactions found in the Ownership History table.

      There are 3 types of conditions we are looking for:

      Type 1: Look specifically for the "Ownership History" table in the raw_content field. This may or may not be in the raw_content field. 
      The table may contain columns like: Owner, Sale Price, Sale Date, etc.
      If the "Ownership History" table is found, (add a transaction for each row in the table)
      Return the type of condition (Type 1 here) and a JSON array in this format:
      [ 
        {
          "type": "Type 1"
        },
        {
          "saleDate": "YYYY-MM-DD",
          "salePrice": "$X,XXX,XXX",
          "buyer": "Current Owner Name",
          "seller": "Previous Owner Name"
        }
      ]
      
      Type 2: Look for any links in markdown format that contain both "parcel.aspx" and a house number with street name. Example markdown format: [8 LYNNBROOK ROAD](https://gis.vgsi.com/fairfieldct/Parcel.aspx?pid=2271)
      If such a link is found, return this JSON format:
      [ 
        {
          "type": "Type 2"
        },
        {
          "address": "8 LYNNBROOK ROAD",
          "link": "https://gis.vgsi.com/fairfieldct/Parcel.aspx?pid=2271"
        }
      ]

      Type 3: If raw_content is null, check if the search address "${searchAddress}" appears in the content field.
      If found, return this JSON format:
      [
        {
          "type": "Type 3"
        },
        {
          "address": "The address found in the content",
          "link": "${resultToUse.url}"
        }
      ]

      Return an empty array [] only if none of the conditions are found.
      
      Raw content to analyze: ${resultToUse.rawContent}
      Content to analyze if raw_content is null: ${resultToUse.content}`;

      console.log('\n=== AI Model Prompt ===');
      console.log('Sending prompt to AI model:', prompt);

      const response = await aiClient.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "You are a specialized assistant focused on extracting property links and transaction data. For Type 2 responses, carefully look for markdown links containing 'parcel.aspx' and matching house numbers. Pay special attention to the exact format: [ADDRESS](URL) where URL contains 'parcel.aspx'."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0,
        top_p: 1,
        model: "openai/gpt-4.1"
      });

      console.log('\n=== AI Model Response ===');
      console.log('Raw AI response:', JSON.stringify(response, null, 2));

      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error('No content received from AI model');
      }
      console.log('Parsed content from AI:', content);
      
      try {
        let parsedData = JSON.parse(content);
        console.log('\n=== Parsed AI Response Data ===');
        console.log('Successfully parsed data:', JSON.stringify(parsedData, null, 2));

        // If we got an empty array, try direct link detection
        if (Array.isArray(parsedData) && parsedData.length === 0 && resultToUse.rawContent) {
          console.log('\n=== Attempting Direct Link Detection ===');
          const linkRegex = /\[([^\]]+)\]\((https:\/\/[^)]+parcel\.aspx\?pid=\d+)\)/g;
          const matches = [...resultToUse.rawContent.matchAll(linkRegex)];
          
          const targetAddress = searchAddress.toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/\s+rd$/i, ' road')
            .replace(/,.*$/, '')
            .trim();

          console.log('Looking for address:', targetAddress);
          
          const matchingLink = matches.find(match => {
            const linkAddress = match[1].toLowerCase()
              .replace(/\s+/g, ' ')
              .trim();
            return linkAddress === targetAddress;
          });

          if (matchingLink) {
            console.log('Found matching link:', matchingLink[0]);
            parsedData = [
              { type: "Type 2" },
              {
                address: matchingLink[1],
                link: matchingLink[2]
              }
            ];
          }
        }

        // Check if we have any data and what type it is
        if (Array.isArray(parsedData) && parsedData.length > 0) {
          const responseType = parsedData[0]?.type;
          console.log('\n=== Response Type ===');
          console.log('Detected response type:', responseType);

          if (responseType === 'Type 1') {
            console.log('\n=== Processing Type 1 Response ===');
            // Remove the type indicator and keep only the transactions
            const transactions = parsedData.slice(1);
            console.log('Extracted transactions:', JSON.stringify(transactions, null, 2));
            return NextResponse.json({
              zipcode,
              city: locationInfo.city,
              county: locationInfo.county_name,
              state: locationInfo.state_name,
              state_id: locationInfo.state_id,
              county_fips: locationInfo.county_fips,
              searchUrl,
              transactions
            });
          } else if (responseType === 'Type 2' || responseType === 'Type 3') {
            console.log('\n=== Processing Type 2 Response ===');
            // Handle Type 2 response by extracting data from the link
            const matchingResult = parsedData.find(item => {
              if (!item.address) return false;
              
              // Normalize both addresses for comparison
              const normalizedSearch = searchAddress.toLowerCase()
                .replace(/\s+road$/i, ' rd')
                .replace(/\s+rd$/i, ' rd')
                .replace(/\s+/g, ' ')
                .trim();
              
              const normalizedItem = item.address.toLowerCase()
                .replace(/\s+road$/i, ' rd')
                .replace(/\s+rd$/i, ' rd')
                .replace(/\s+/g, ' ')
                .trim();
              
              return normalizedSearch === normalizedItem;
            });
            
            if (!matchingResult?.link) {
              throw new Error('No matching link found for the search address');
            }

            console.log('Extracting data from link:', matchingResult.link);
            console.log('\n=== Starting Tavily Extract ===');
            const extractResult = await client.extract([matchingResult.link], {
              extractDepth: "advanced"
            });
            console.log('Tavily extract result:', JSON.stringify(extractResult, null, 2));

            if (!extractResult?.results?.[0]?.rawContent) {
              throw new Error('No content extracted from the link');
            }

            console.log('\n=== Starting Second AI Model Request ===');
            // Run a simplified prompt focused only on extracting the ownership history
            const newResponse = await aiClient.chat.completions.create({
              messages: [
                {
                  role: "system",
                  content: "You are a specialized assistant focused on extracting property transaction data from Ownership History tables. Your primary task is to find and parse the ownership history table data, which typically includes sale dates, prices, and owner names. Pay special attention to tables labeled as 'Ownership History' or similar variations."
                },
                {
                  role: "user",
                  content: `Find and extract property sale transactions from the Ownership History table in the following data. The table should contain columns for Owner/Buyer, Sale Price, and Sale Date.

                  Format each transaction as follows:
                  - saleDate should be in YYYY-MM-DD format
                  - salePrice should include the dollar sign and commas
                  - buyer should be the name in the Owner column
                  - seller should be derived from the previous owner in the chronological sequence

                  Return ONLY an array of transactions in this format:
                  [
                    {
                      "saleDate": "YYYY-MM-DD",
                      "salePrice": "$X,XXX,XXX",
                      "buyer": "Current Owner Name",
                      "seller": "Previous Owner Name"
                    }
                  ]
                  
                  Raw content to analyze: ${extractResult.results[0].rawContent}`
                }
              ],
              temperature: 0,
              top_p: 1,
              model: "openai/gpt-4.1"
            });

            console.log('Second AI model response:', JSON.stringify(newResponse, null, 2));

            const newContent = newResponse.choices[0].message.content;
            if (!newContent) {
              throw new Error('No content received from second AI model call');
            }

            console.log('\n=== Processing Second AI Response ===');
            const transactions = JSON.parse(newContent);
            console.log('Parsed transactions:', JSON.stringify(transactions, null, 2));

            if (Array.isArray(transactions) && transactions.length > 0) {
              console.log('\n=== Processing Transactions ===');
              console.log('Final extracted transactions:', JSON.stringify(transactions, null, 2));
              return NextResponse.json({
                zipcode,
                city: locationInfo.city,
                county: locationInfo.county_name,
                state: locationInfo.state_name,
                state_id: locationInfo.state_id,
                county_fips: locationInfo.county_fips,
                searchUrl,
                transactions
              });
            } else {
              console.log('\n=== No Valid Transactions Found ===');
              // If we don't get transaction data, return empty array
              return NextResponse.json({
                zipcode,
                city: locationInfo.city,
                county: locationInfo.county_name,
                state: locationInfo.state_name,
                state_id: locationInfo.state_id,
                county_fips: locationInfo.county_fips,
                searchUrl,
                transactions: []
              });
            }
          } else if (responseType === 'Type 3') {
            console.log('\n=== Processing Type 3 Response ===');
            // Handle Type 3 response by extracting data from the content
            const address = parsedData[0].address;
            if (!address) {
              throw new Error('No address found in Type 3 response');
            }

            console.log('Extracting data from content:', address);
            console.log('\n=== Starting Second AI Model Request ===');
            // Run a simplified prompt focused only on extracting the ownership history
            const newResponse = await aiClient.chat.completions.create({
              messages: [
                {
                  role: "system",
                  content: "You are a specialized assistant focused on extracting property transaction data from Ownership History tables. Your primary task is to find and parse the ownership history table data, which typically includes sale dates, prices, and owner names. Pay special attention to tables labeled as 'Ownership History' or similar variations."
                },
                {
                  role: "user",
                  content: `Find and extract property sale transactions from the Ownership History table in the following data. The table should contain columns for Owner/Buyer, Sale Price, and Sale Date.

                  Format each transaction as follows:
                  - saleDate should be in YYYY-MM-DD format
                  - salePrice should include the dollar sign and commas
                  - buyer should be the name in the Owner column
                  - seller should be derived from the previous owner in the chronological sequence

                  Return ONLY an array of transactions in this format:
                  [
                    {
                      "saleDate": "YYYY-MM-DD",
                      "salePrice": "$X,XXX,XXX",
                      "buyer": "Current Owner Name",
                      "seller": "Previous Owner Name"
                    }
                  ]
                  
                  Raw content to analyze: ${address}`
                }
              ],
              temperature: 0,
              top_p: 1,
              model: "openai/gpt-4.1"
            });

            console.log('Second AI model response:', JSON.stringify(newResponse, null, 2));

            const newContent = newResponse.choices[0].message.content;
            if (!newContent) {
              throw new Error('No content received from second AI model call');
            }

            console.log('\n=== Processing Second AI Response ===');
            const transactions = JSON.parse(newContent);
            console.log('Parsed transactions:', JSON.stringify(transactions, null, 2));

            if (Array.isArray(transactions) && transactions.length > 0) {
              console.log('\n=== Processing Transactions ===');
              console.log('Final extracted transactions:', JSON.stringify(transactions, null, 2));
              return NextResponse.json({
                zipcode,
                city: locationInfo.city,
                county: locationInfo.county_name,
                state: locationInfo.state_name,
                state_id: locationInfo.state_id,
                county_fips: locationInfo.county_fips,
                searchUrl,
                transactions
              });
            } else {
              console.log('\n=== No Valid Transactions Found ===');
              // If we don't get transaction data, return empty array
              return NextResponse.json({
                zipcode,
                city: locationInfo.city,
                county: locationInfo.county_name,
                state: locationInfo.state_name,
                state_id: locationInfo.state_id,
                county_fips: locationInfo.county_fips,
                searchUrl,
                transactions: []
              });
            }
          }
        }

        console.log('\n=== No Valid Response Type Found ===');
        // If no valid type is found, return empty transactions
        return NextResponse.json({
          zipcode,
          city: locationInfo.city,
          county: locationInfo.county_name,
          state: locationInfo.state_name,
          state_id: locationInfo.state_id,
          county_fips: locationInfo.county_fips,
          searchUrl,
          transactions: []
        });
      } catch (parseError) {
        console.error('\n=== JSON Parse Error ===');
        console.error('Failed to parse AI response as JSON:', parseError);
        console.error('Raw content that failed to parse:', content);
        throw new Error('Failed to parse AI response as JSON');
      }
    } catch (error: unknown) {
      console.error('\n=== Error Processing Transactions ===');
      console.error('Error processing transactions:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to process transactions';
      console.error('Error details:', errorMessage);
      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  } catch (error) {
    console.error('\n=== Fatal Error ===');
    console.error('Error processing transactions:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to process transactions';
    console.error('Error details:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}