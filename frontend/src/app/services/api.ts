import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
}

export interface LoginResponse {
  success: boolean;
  message: string;
}

export interface AnalysisMeter {
  color: 'green' | 'yellow' | null;
  percent: number | null;
}

export interface AnalysisCriterion {
  text: string;
  status: 'green' | 'yellow' | 'gray';
}

export interface StopCvMatchResponse {
  stopped: boolean;
}

export interface CvMatchJobResult {
  jobIndex: number;
  success: boolean;
  analysis: string | null;
  meter: AnalysisMeter | null;
  criteria: AnalysisCriterion[];
  jobUrl: string | null;
  errorMessage: string | null;
  applicationUrl: string | null;
}

export interface CvMatchResponse {
  success: boolean;
  errorMessage: string | null;
  totalJobsCount: number | null;
  resultsUrl: string | null;
  results: CvMatchJobResult[];
}

@Injectable({ providedIn: 'root' })
export class Api {
  constructor(private readonly http: HttpClient) {}

  getHealth(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>('/api/health');
  }

  login(credentials: { email: string; password: string; useJobsCh: boolean }): Observable<LoginResponse> {
    return this.http.post<LoginResponse>('/api/login', credentials);
  }

  cvMatch(options: {
    startJobIndex: number;
    endJobIndex: number;
    useBasicSearch: boolean;
    cdiOnly: boolean;
    cddOnly: boolean;
    searchTerm: string;
    locations: string[];
    saveJob: boolean;
    easyApply: boolean;
    ignoreYellowMeter: boolean;
    useJobsCh: boolean;
  }): Observable<CvMatchResponse> {
    return this.http.post<CvMatchResponse>('/api/cv-match', options);
  }

  stopCvMatch(): Observable<StopCvMatchResponse> {
    return this.http.post<StopCvMatchResponse>('/api/cv-match/stop', {});
  }
}
