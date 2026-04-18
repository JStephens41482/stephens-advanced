function App() {
  return (
    <>
      <window.Scorecard />
      <window.Cohesion />
      <window.WebsiteSection />
      <window.AppSection />
      <window.PortalSection />
      <window.ChatSection />
      <window.ReportsSection />
      <window.RikerAgenticSection />
      <window.HiddenNavSection />
      <window.CorrectionsSection />
      <window.Roadmap />
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App/>);
