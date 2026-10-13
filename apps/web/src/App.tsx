import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.tsx';
import { AppShell, RequireAuth } from './components/AppShell.tsx';
import { LoginScreen } from './screens/Login.tsx';
import { ProposalsListScreen } from './screens/ProposalsList.tsx';
import { AccountScreen } from './screens/Account.tsx';
import { TeamScreen } from './screens/Team.tsx';
import { AcceptInviteScreen } from './screens/AcceptInvite.tsx';
import { UploadScreen } from './screens/Upload.tsx';
import { AnalyzingScreen } from './screens/Analyzing.tsx';
import { ReviewScreen } from './screens/review/ReviewScreen.tsx';
import { ResultScreen } from './screens/Result.tsx';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
          {/* Public: the person following an invite has no account yet. */}
          <Route path="/invite/:token" element={<AcceptInviteScreen />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<ProposalsListScreen />} />
              <Route path="/account" element={<AccountScreen />} />
              <Route path="/team" element={<TeamScreen />} />
              <Route path="/proposals/new" element={<UploadScreen />} />
              <Route path="/proposals/:id/analyzing" element={<AnalyzingScreen />} />
              <Route path="/proposals/:id/review" element={<ReviewScreen />} />
              <Route path="/proposals/:id/result" element={<ResultScreen />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
