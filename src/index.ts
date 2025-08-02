#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';

// Types for SEC data structures
interface InsiderTransaction {
  cik: string;
  personName: string;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  officerTitle?: string;
  transactionDate: string;
  transactionCode: string;
  transactionShares: number;
  transactionPricePerShare: number;
  transactionValue: number;
  sharesOwnedAfter: number;
  directOrIndirect: 'D' | 'I';
  formType: string;
  filingDate: string;
  documentUrl: string;
}

interface CompanyInfo {
  cik: string;
  ticker: string;
  companyName: string;
  exchange: string;
}

interface SecApiResponse {
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      acceptanceDateTime: string[];
      act: string[];
      form: string[];
      fileNumber: string[];
      filmNumber: string[];
      items: string[];
      size: number[];
      isXBRL: number[];
      isInlineXBRL: number[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

class SecInsiderTradingServer {
  private server: Server;
  private xmlParser: XMLParser;
  private readonly baseUrl = 'https://data.sec.gov';
  private readonly companyTickersUrl = 'https://www.sec.gov';
  
  // Rate limiting - SEC requirement: maximum 10 requests per second
  private lastRequestTime = 0;
  private readonly minRequestInterval = 100; // 100ms = 10 requests per second

  constructor() {
    this.server = new Server(
      {
        name: "sec-insider-trading-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      parseAttributeValue: true,
      trimValues: true
    });

    this.setupToolHandlers();
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  private getHeaders(host: string = 'www.sec.gov') {
    return {
      'User-Agent': 'Sample Company Name AdminContact@samplecompany.com',
      'Accept-Encoding': 'gzip, deflate',
      'Host': host
    };
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "search_company_cik",
            description: "Search for a company's CIK (Central Index Key) by ticker symbol or company name",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Company ticker symbol or company name to search for"
                }
              },
              required: ["query"]
            }
          },
          {
            name: "get_insider_transactions",
            description: "Get recent insider trading transactions for a company using CIK",
            inputSchema: {
              type: "object",
              properties: {
                cik: {
                  type: "string",
                  description: "Company CIK (Central Index Key)"
                },
                limit: {
                  type: "number",
                  description: "Maximum number of filings to retrieve (default: 20)",
                  default: 20
                },
                form_types: {
                  type: "array",
                  items: { type: "string" },
                  description: "Form types to filter by (3, 4, 5, 3/A, 4/A, 5/A)",
                  default: ["3", "4", "5", "3/A", "4/A", "5/A"]
                }
              },
              required: ["cik"]
            }
          },
          {
            name: "parse_form4_filing",
            description: "Parse a specific Form 4 filing to extract detailed transaction information",
            inputSchema: {
              type: "object",
              properties: {
                cik: {
                  type: "string",
                  description: "Company CIK"
                },
                accession_number: {
                  type: "string",
                  description: "SEC accession number for the filing"
                }
              },
              required: ["cik", "accession_number"]
            }
          },
          {
            name: "get_executive_transactions",
            description: "Get insider transactions filtered by executive role (CEO, CFO, etc.)",
            inputSchema: {
              type: "object",
              properties: {
                cik: {
                  type: "string",
                  description: "Company CIK"
                },
                role_filter: {
                  type: "string",
                  description: "Filter by executive role (CEO, CFO, President, Director, etc.)",
                  default: "all"
                },
                date_from: {
                  type: "string",
                  description: "Start date for filtering transactions (YYYY-MM-DD format)"
                },
                date_to: {
                  type: "string",
                  description: "End date for filtering transactions (YYYY-MM-DD format)"
                }
              },
              required: ["cik"]
            }
          },
          {
            name: "analyze_insider_trends",
            description: "Analyze insider trading trends and patterns for a company",
            inputSchema: {
              type: "object",
              properties: {
                cik: {
                  type: "string",
                  description: "Company CIK"
                },
                period_months: {
                  type: "number",
                  description: "Number of months to analyze (default: 12)",
                  default: 12
                }
              },
              required: ["cik"]
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (!args) {
        return {
          content: [
            {
              type: "text",
              text: `Error: No arguments provided for ${name}`
            }
          ]
        };
      }

      try {
        switch (name) {
          case "search_company_cik":
            return await this.searchCompanyCik((args as any).query);
          
          case "get_insider_transactions":
            return await this.getInsiderTransactions(
              (args as any).cik,
              (args as any).limit || 20,
              (args as any).form_types || ["3", "4", "5", "3/A", "4/A", "5/A"]
            );
          
          case "parse_form4_filing":
            return await this.parseForm4Filing((args as any).cik, (args as any).accession_number);
          
          case "get_executive_transactions":
            return await this.getExecutiveTransactions(
              (args as any).cik,
              (args as any).role_filter || "all",
              (args as any).date_from,
              (args as any).date_to
            );
          
          case "analyze_insider_trends":
            return await this.analyzeInsiderTrends((args as any).cik, (args as any).period_months || 12);
          
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error executing ${name}: ${errorMessage}`
            }
          ]
        };
      }
    });
  }

  private async searchCompanyCik(query: string) {
    await this.rateLimit();
    
    try {
      // Use the SEC company tickers JSON endpoint
      const response = await axios.get(
        `${this.companyTickersUrl}/files/company_tickers.json`,
        { 
          headers: this.getHeaders('www.sec.gov'),
          timeout: 30000
        }
      );
      
      const companies = Object.values(response.data) as any[];
      const matches = companies.filter(company => 
        company.ticker?.toLowerCase() === query.toLowerCase() ||
        company.title?.toLowerCase().includes(query.toLowerCase())
      );

      if (matches.length > 0) {
        const results = matches.map(company => ({
          cik: company.cik_str.toString().padStart(10, '0'),
          ticker: company.ticker,
          companyName: company.title
        }));

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} matching companies:\n\n` +
                results.map(r => `CIK: ${r.cik}\nTicker: ${r.ticker}\nCompany: ${r.companyName}`).join('\n\n')
            }
          ]
        };
      }

      throw new Error(`No companies found matching "${query}"`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to search company CIK: ${errorMessage}`);
    }
  }

  private async getInsiderTransactions(cik: string, limit: number = 20, formTypes: string[] = ["3", "4", "5"]) {
    await this.rateLimit();
    
    try {
      const paddedCik = cik.padStart(10, '0');
      const response = await axios.get(
        `${this.baseUrl}/submissions/CIK${paddedCik}.json`,
        { 
          headers: this.getHeaders('data.sec.gov'),
          timeout: 30000
        }
      );

      const data: SecApiResponse = response.data;
      const recentFilings = data.filings.recent;
      
      // Filter for insider trading forms
      const insiderForms = [];
      for (let i = 0; i < recentFilings.form.length && insiderForms.length < limit; i++) {
        const formType = recentFilings.form[i];
        const accessionNumber = recentFilings.accessionNumber[i];
        const primaryDocument = recentFilings.primaryDocument[i];
        
        if (formType && formTypes.includes(formType) && accessionNumber && primaryDocument) {
          insiderForms.push({
            accessionNumber: accessionNumber,
            filingDate: recentFilings.filingDate[i],
            form: formType,
            primaryDocument: primaryDocument,
            documentUrl: `${this.baseUrl}/Archives/edgar/data/${parseInt(cik)}/${accessionNumber.replace(/-/g, '')}/${primaryDocument}`
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${insiderForms.length} recent insider trading filings:\n\n` +
              insiderForms.map(filing => 
                `Form: ${filing.form}\n` +
                `Filing Date: ${filing.filingDate}\n` +
                `Accession Number: ${filing.accessionNumber}\n` +
                `Document URL: ${filing.documentUrl}`
              ).join('\n\n')
          }
        ]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get insider transactions for CIK ${cik}: ${errorMessage}`);
    }
  }

  private async parseForm4Filing(cik: string, accessionNumber: string) {
    await this.rateLimit();
    
    try {
      const paddedCik = cik.padStart(10, '0');
      const cleanAccessionNumber = accessionNumber.replace(/-/g, '');
      
      // Get the primary document name first
      const submissionResponse = await axios.get(
        `${this.baseUrl}/submissions/CIK${paddedCik}.json`,
        { 
          headers: this.getHeaders('data.sec.gov'),
          timeout: 30000
        }
      );

      const filings = submissionResponse.data.filings.recent;
      const filingIndex = filings.accessionNumber.indexOf(accessionNumber);
      
      if (filingIndex === -1) {
        throw new Error(`Filing ${accessionNumber} not found`);
      }

      const primaryDocument = filings.primaryDocument[filingIndex];
      
      const documentUrl = `${this.baseUrl}/Archives/edgar/data/${parseInt(cik)}/${cleanAccessionNumber}/${primaryDocument}`;
      
      await this.rateLimit();
      const documentResponse = await axios.get(documentUrl, { 
        headers: this.getHeaders('data.sec.gov'),
        timeout: 30000
      });

      // Parse the XML/HTML content
      const $ = cheerio.load(documentResponse.data);
      
      // Extract key information from Form 4
      const transactions = [];
      
      // Look for transaction tables (this is a simplified parser)
      $('table').each((i, table) => {
        const $table = $(table);
        
        // Check if this looks like a transaction table
        if ($table.text().includes('Transaction') || $table.text().includes('Shares')) {
          $table.find('tr').each((j, row) => {
            const $row = $(row);
            const cells = $row.find('td, th').map((k, cell) => $(cell).text().trim()).get();
            
            if (cells.length > 5 && cells[0] && !cells[0].toLowerCase().includes('transaction')) {
              // This is likely a data row
              transactions.push({
                data: cells,
                rawRow: $row.html()
              });
            }
          });
        }
      });

      // Extract filer information
      const filerInfo = {
        name: $('filerName, FILER_NAME').text() || 'Not found',
        cik: $('filerCik, FILER_CIK').text() || cik,
        relationship: {
          isDirector: $('isDirector, IS_DIRECTOR').text() === '1',
          isOfficer: $('isOfficer, IS_OFFICER').text() === '1',
          isTenPercentOwner: $('isTenPercentOwner, IS_TEN_PERCENT_OWNER').text() === '1',
          officerTitle: $('officerTitle, OFFICER_TITLE').text() || 'Not specified'
        }
      };

      return {
        content: [
          {
            type: "text",
            text: `Form 4 Filing Analysis:\n\n` +
              `Filer Information:\n` +
              `Name: ${filerInfo.name}\n` +
              `CIK: ${filerInfo.cik}\n` +
              `Is Director: ${filerInfo.relationship.isDirector}\n` +
              `Is Officer: ${filerInfo.relationship.isOfficer}\n` +
              `Officer Title: ${filerInfo.relationship.officerTitle}\n` +
              `Is 10% Owner: ${filerInfo.relationship.isTenPercentOwner}\n\n` +
              `Transactions Found: ${transactions.length}\n\n` +
              `Document URL: ${documentUrl}\n\n` +
              `Note: This is a basic parser. For detailed transaction data, ` +
              `additional XML parsing of specific SEC XML schemas would be needed.`
          }
        ]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse Form 4 filing: ${errorMessage}`);
    }
  }

  private async getExecutiveTransactions(cik: string, roleFilter: string, dateFrom?: string, dateTo?: string) {
    // This would build on the getInsiderTransactions method with additional filtering
    const transactions = await this.getInsiderTransactions(cik, 50);
    
    return {
      content: [
        {
          type: "text",
          text: `Executive transactions filtering is implemented as a basic structure.\n` +
            `Role filter: ${roleFilter}\n` +
            `Date range: ${dateFrom || 'N/A'} to ${dateTo || 'N/A'}\n\n` +
            `This would require parsing individual filings to extract executive titles and filter accordingly.\n` +
            `Use parse_form4_filing on specific filings for detailed information.`
        }
      ]
    };
  }

  private async analyzeInsiderTrends(cik: string, periodMonths: number) {
    const transactions = await this.getInsiderTransactions(cik, 100);
    
    return {
      content: [
        {
          type: "text",
          text: `Insider Trading Trend Analysis:\n\n` +
            `Company CIK: ${cik}\n` +
            `Analysis Period: ${periodMonths} months\n\n` +
            `This analysis would include:\n` +
            `- Buy vs Sell transaction ratios\n` +
            `- Volume trends over time\n` +
            `- Executive vs Director trading patterns\n` +
            `- Seasonal patterns\n` +
            `- Average transaction sizes\n\n` +
            `Implementation would require parsing multiple Form 4 filings ` +
            `and aggregating the transaction data for statistical analysis.`
        }
      ]
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("SEC Insider Trading MCP Server running on stdio");
  }
}

const server = new SecInsiderTradingServer();
server.run().catch(console.error);
