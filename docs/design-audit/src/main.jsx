function App() {
  return (
    <>
      <window.Scorecard />
      <window.Cohesion />
      <window.WebsiteSection />
      <window.AppSection />
      <window.PortalSection />
      <window.ChatSection />
      <window.Roadmap />
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App/>);
