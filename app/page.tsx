import AddressSearch from './components/AddressSearch';

export default function Home() {
  return (
    <main className="min-h-screen p-8 bg-background">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight">
          Real Estate Transaction Search
        </h1>
        <p className="text-muted-foreground mt-2">
          Search for property transactions by address
        </p>
      </div>
      <AddressSearch />
    </main>
  );
}
