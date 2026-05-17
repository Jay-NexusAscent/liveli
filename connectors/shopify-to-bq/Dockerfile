FROM meltano/meltano:v3.7.1
WORKDIR /project
COPY meltano.yml ./
RUN meltano install
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENTRYPOINT ["./entrypoint.sh"]
