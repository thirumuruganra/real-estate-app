'use client';

import { useState } from 'react';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CheckCircle2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ProcessingStep {
  id: string;
  message: string;
  status: 'pending' | 'complete' | 'error';
  timestamp: string;
}

interface Transaction {
  saleDate: string;
  salePrice: string;
  buyer: string;
  seller: string;
}

interface SearchResult {
  zipcode: string;
  city: string;
  county: string;
  state: string;
  state_id: string;
  transactions: Transaction[];
  error?: string;
}

export default function AddressSearch() {
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [steps, setSteps] = useState<ProcessingStep[]>([]);
  const [stepCounter, setStepCounter] = useState(0);

  function addStep(message: string, status: ProcessingStep['status'] = 'pending') {
    setStepCounter(prev => prev + 1);
    setSteps(prev => [...prev, {
      id: `step-${stepCounter}`,
      message,
      status,
      timestamp: new Date().toLocaleTimeString()
    }]);
  }

  function updateLastStep(status: ProcessingStep['status']) {
    setSteps(prev => {
      const newSteps = [...prev];
      if (newSteps.length > 0) {
        newSteps[newSteps.length - 1].status = status;
      }
      return newSteps;
    });
  }

  async function handleSearch() {
    if (!address.trim()) {
      setError('Please enter an address');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setSteps([]);
    setStepCounter(0);

    try {
      addStep('Processing address and extracting ZIP code...');
      const response = await fetch('/api/process-address', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address }),
      });

      const data = await response.json();

      if (!response.ok) {
        updateLastStep('error');
        throw new Error(data.error || 'Failed to process address');
      }

      updateLastStep('complete');
      addStep('Found location information', 'complete');

      if (data.transactions && data.transactions.length > 0) {
        addStep('Found property transactions', 'complete');
      } else {
        addStep('No transactions found for this property', 'complete');
      }

      setResult(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setError(errorMessage);
      updateLastStep('error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-3xl mx-auto mt-8">
      <CardHeader>
        <CardTitle>Property Transaction Search</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-4 mb-6">
          <Input
            placeholder="Enter address with ZIP code (e.g., 123 Main St, 12345)"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !loading) {
                handleSearch();
              }
            }}
            className="flex-1"
          />
          <Button 
            onClick={handleSearch} 
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Searching...
              </>
            ) : (
              'Search'
            )}
          </Button>
        </div>

        {/* Processing Steps */}
        {steps.length > 0 && (
          <div className="space-y-2 mb-6">
            {steps.map((step) => (
              <div key={`${step.id}-${step.timestamp}`} className="flex items-center gap-2 text-sm">
                {step.status === 'pending' && (
                  <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                )}
                {step.status === 'complete' && (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                )}
                {step.status === 'error' && (
                  <span className="text-red-500">⚠</span>
                )}
                <span className="text-muted-foreground">{step.timestamp}</span>
                <span>{step.message}</span>
              </div>
            ))}
          </div>
        )}

        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <h3 className="font-semibold mb-2">Location Details</h3>
                <p>City: {result.city}</p>
                <p>County: {result.county}</p>
                <p>State: {result.state} ({result.state_id})</p>
                <p>ZIP Code: {result.zipcode}</p>
              </div>
            </div>

            {result.transactions && result.transactions.length > 0 ? (
              <>
                <h3 className="font-semibold mb-2">Transaction History</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Buyer</TableHead>
                      <TableHead>Seller</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.transactions.map((transaction, index) => (
                      <TableRow key={index}>
                        <TableCell>{transaction.saleDate}</TableCell>
                        <TableCell>{transaction.salePrice}</TableCell>
                        <TableCell>{transaction.buyer}</TableCell>
                        <TableCell>{transaction.seller}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : (
              <Alert>
                <AlertDescription>
                  No transaction records found for this property.
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
} 